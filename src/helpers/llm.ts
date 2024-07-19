import OpenAI from 'openai';
import { getConfig } from './config';
import { KnownError } from './error';
import { commandName } from './constants';
import { systemPrompt } from './systemPrompt';
import { RunCreateParams } from 'openai/resources/beta/threads/runs/runs';
import { RunOptions } from './run';
import { log } from '@clack/prompts';
import { green } from 'kolorist';
import { formatMessage } from './test';
import { removeBackticks } from './remove-backticks';
import ollama from 'ollama';
import dedent from 'dedent';
import { removeInitialSlash } from './remove-initial-slash';
import { captureLlmRecord, mockedLlmCompletion } from './mock-llm';
import { getCodeBlock } from './interactive-mode';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const defaultModel = 'gpt-4o';
const assistantIdentifierMetadataKey = '_id';
const assistantIdentifierMetadataValue = '@builder.io/micro-agent';

const useOllama = (model?: string) => {
  return model?.includes('llama') || model?.includes('phi');
};

const useAnthropic = (model?: string) => {
  return model?.includes('claude');
};

const supportsFunctionCalling = (model?: string) => {
  return !!{
    'gpt-4o': true,
    'gpt-4o-2024-05-13': true,
    'gpt-4-turbo': true,
    'gpt-4-turbo-2024-04-09': true,
    'gpt-4-turbo-preview': true,
    'gpt-4-0125-preview': true,
    'gpt-4-1106-preview': true,
    'gpt-4': true,
    'gpt-4-0613': true,
    'gpt-3.5-turbo': true,
    'gpt-3.5-turbo-0125': true,
    'gpt-3.5-turbo-1106': true,
    'gpt-3.5-turbo-0613': true,
  }[model || ''];
};

const generateRandomString = (length) => {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
};

const savePromptAndResponse = (message, response) => {
  const randomString = generateRandomString(5);
  const filePath = path.join(process.env.HOME || process.env.USERPROFILE, `message_${randomString}.txt`);
  const content = JSON.stringify({ message, response }, null, 2);
  fs.writeFileSync(filePath, content, 'utf8');
};

export const getOpenAi = async function () {
  const { OPENAI_KEY: openaiKey, OPENAI_API_ENDPOINT: endpoint } =
    await getConfig();
  if (!openaiKey) {
    throw new KnownError(
      `Missing OpenAI key. Use \`${commandName} config\` to set it.`
    );
  }
  const openai = new OpenAI({
    apiKey: openaiKey,
    baseURL: endpoint,
  });
  return openai;
};

export const getAnthropic = async function () {
  const { ANTHROPIC_KEY: anthropicKey } = await getConfig();
  if (!anthropicKey) {
    throw new KnownError(
      `Missing Anthropic key. Use \`${commandName} config\` to set it.`
    );
  }
  const anthropic = new Anthropic({
    apiKey: anthropicKey,
  });
  return anthropic;
};

export const getFileSuggestion = async function (
  prompt: string,
  fileString: string
) {
  const message = {
    role: 'user' as const,
    content: dedent`
    Please give me a recommended file path for the following prompt:
    <prompt>
    ${prompt}
    </prompt>

    Here is a preview of the files in the current directory for reference. Please
    use these as a reference as to what a good file name, language, and path would be
    to match the other files in the project given the naming/folder/language conventions.

    For instance, if the other files are in TypeScript, the file path should end in .ts.
    And if the most common casing in the file tree is dash-case, the file path should be dash-case.
    <files>
    ${fileString}
    </files>


    `,
  };
  const { MODEL: model } = await getConfig();
  if (
    useOllama(model) ||
    useAnthropic(model) ||
    !supportsFunctionCalling(model)
  ) {
    const response = removeInitialSlash(
      removeBackticks(
        await getSimpleCompletion({
          messages: [
            {
              role: 'system' as const,
              content:
                'You are an assistant that given a snapshot of the current filesystem suggests a relative file path for the code algorithm mentioned in the prompt. No other words, just one file path',
            },
            message,
          ],
        })
      )
    );
    savePromptAndResponse(message, response);
    return response;
  }
  const openai = await getOpenAi();
  const completion = await openai.chat.completions.create({
    model: model || defaultModel,
    tool_choice: {
      type: 'function',
      function: { name: 'file_suggestion' },
    },
    tools: [
      {
        type: 'function',
        function: {
          name: 'file_suggestion',
          description:
            'Given a prompt and a list of files, suggest a file path',
          parameters: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description:
                  'Relative file path to the file that the code algorithm should be written in, in case of doubt the extension should be .js',
              },
            },
            required: ['filePath'],
          },
        },
      },
    ],
    messages: [
      {
        role: 'system' as const,
        content:
          'You are an assistant that given a snapshot of the current filesystem suggests a relative file path for the code algorithm mentioned in the prompt.',
      },
      message,
    ],
  });
  const jsonStr =
    completion.choices[0]?.message.tool_calls?.[0]?.function.arguments;
  if (!jsonStr) {
    const response = 'src/algorithm.js';
    savePromptAndResponse(message, response);
    return response;
  }
  const response = removeInitialSlash(JSON.parse(jsonStr).filePath);
  savePromptAndResponse(message, response);
  return response;
};

export const getSimpleCompletion = async function (options: {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  onChunk?: (chunk: string) => void;
}) {
  const {
    MODEL: model,
    MOCK_LLM_RECORD_FILE: mockLlmRecordFile,
    USE_MOCK_LLM: useMockLlm,
  } = await getConfig();

  const prompt = options.messages.map(msg => msg.content).join('\n');

  if (useMockLlm) {
    const response = await mockedLlmCompletion(mockLlmRecordFile, options.messages);
    return response;
  }

  if (useAnthropic(model)) {
    let output = '';
    const anthropic = await getAnthropic();
    const systemMessage = options.messages.find(
      (message) => message.role === 'system'
    );
    const result = anthropic.messages
      .stream({
        model:
          (model as string) === 'claude' ? 'claude-3-5-sonnet-20240620' : model,
        max_tokens: 4096,
        system: systemMessage?.content as string,
        messages: options.messages.filter(
          (message) => message.role !== 'system'
        ) as any[],
      })
      .on('text', (text) => {
        output += text;
        if (options.onChunk) {
          options.onChunk(text);
        }
      });

    await result.done();
    captureLlmRecord(options.messages, output, mockLlmRecordFile);
    savePromptAndResponse(options.messages, output);
    return output;
  }

  if (useOllama(model)) {
    const response = await ollama.chat({
      model: model,
      messages: options.messages as any[],
      stream: true,
    });

    let output = '';

    for await (const chunk of response) {
      output += chunk.message.content;
      if (options.onChunk) {
        options.onChunk(chunk.message.content);
      }
    }
    captureLlmRecord(options.messages, output, mockLlmRecordFile);
    savePromptAndResponse(options.messages, output);
    return output;
  }

  const openai = await getOpenAi();
  const completion = await openai.chat.completions.create({
    model: model || defaultModel,
    messages: options.messages,
    temperature: 0,
    seed: 42,
    stream: true,
  });

  let output = '';

  for await (const chunk of completion) {
    const str = chunk.choices[0]?.delta.content;
    if (str) {
      output += str;
      if (options.onChunk) {
        options.onChunk(str);
      }
    }
  }

  captureLlmRecord(options.messages, output, mockLlmRecordFile);
  savePromptAndResponse(options.messages, output);
  return output;
};

export const getCompletion = async function (options: {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  options: RunOptions;
  useAssistant?: boolean;
}) {
  const {
    MODEL: model,
    MOCK_LLM_RECORD_FILE: mockLlmRecordFile,
    USE_MOCK_LLM: useMockLlm,
    OPENAI_API_ENDPOINT: endpoint,
    USE_ASSISTANT,
  } = await getConfig();

  const prompt = options.messages.map(msg => msg.content).join('\n');

  if (useMockLlm) {
    const response = await mockedLlmCompletion(mockLlmRecordFile, options.messages);
    savePromptAndResponse(options.messages, response);
    return response;
  }

  const useModel = model || defaultModel;
  const useOllamaChat = useOllama(useModel);

  if (useAnthropic(useModel)) {
    process.stdout.write(formatMessage('\n'));
    const output = await getSimpleCompletion({
      messages: options.messages,
      onChunk: (chunk) => {
        process.stderr.write(formatMessage(chunk));
      },
    });
    process.stdout.write(formatMessage('\n'));
    savePromptAndResponse(options.messages, output);
    return output;
  }

  if (useOllamaChat) {
    process.stdout.write(formatMessage('\n'));
    const output = await getSimpleCompletion({
      messages: options.messages,
      onChunk: (chunk) => {
        process.stderr.write(formatMessage(chunk));
      },
    });
    process.stdout.write(formatMessage('\n'));
    savePromptAndResponse(options.messages, output);
    return output;
  }

  const openai = await getOpenAi();

  if (options.useAssistant ?? (USE_ASSISTANT && !endpoint)) {
    let assistantId: string;
    const assistants = await openai.beta.assistants.list({
      limit: 100,
    });
    const assistant = assistants.data.find(
      (assistant) =>
        (assistant.metadata as any)?.[assistantIdentifierMetadataKey] ===
        assistantIdentifierMetadataValue
    );
    if (assistant) {
      assistantId = assistant.id;
    } else {
      const assistant = await openai.beta.assistants.create({
        name: 'Micro Agent',
        model: useModel,
        metadata: {
          [assistantIdentifierMetadataKey]: assistantIdentifierMetadataValue,
        },
      });
      assistantId = assistant.id;
    }
    let threadId = options.options.threadId;
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      log.info(`Created thread: ${green(threadId)}`);
    }
    options.options.threadId = threadId;

    process.stdout.write(formatMessage('\n'));

    let result = '';
    return new Promise<string>((resolve) => {
      openai.beta.threads.runs
        .stream(threadId, {
          instructions: systemPrompt,
          assistant_id: assistantId,
          additional_messages: options.messages.filter(
            (message) => message.role !== 'system'
          ) as RunCreateParams.AdditionalMessage[],
        })
        .on('textDelta', (textDelta) => {
          const str = textDelta.value || '';
          if (str) {
            result += textDelta.value;
            process.stderr.write(formatMessage(str));
          }
        })
        .on('textDone', () => {
          process.stdout.write('\n');
          const output = getCodeBlock(result);
          captureLlmRecord(options.messages, output, mockLlmRecordFile);
          savePromptAndResponse(options.messages, output);
          resolve(output);
        });
    });
  } else {
    const completion = await openai.chat.completions.create({
      model: model || defaultModel,
      messages: options.messages,
      stream: true,
    });
    let output = '';
    process.stdout.write(formatMessage('\n'));
    for await (const chunk of completion) {
      const str = chunk.choices[0]?.delta.content;
      if (str) {
        output += str;
        process.stderr.write(formatMessage(str));
      }
    }
    process.stdout.write('\n');
    captureLlmRecord(options.messages, output, mockLlmRecordFile);
    savePromptAndResponse(options.messages, output);
    return output;
  }
};