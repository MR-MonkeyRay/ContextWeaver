import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

function replaceControlCharacters(value: string, preserveLineBreaks = false): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (preserveLineBreaks && codePoint === 10) {
      return '\n';
    }
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  }).join('');
}

const authorizationReasonSchema = z.enum([
  'elicitation_unsupported',
  'elicitation_declined',
  'elicitation_cancelled',
  'approval_false',
  'invalid_elicitation_response',
  'elicitation_failed',
]);

export const authorizationMetadataSchema = z.object({
  repoPath: z.string(),
  reason: authorizationReasonSchema,
  message: z.string(),
  cliExecutable: z.string(),
  cliArgs: z.array(z.string()),
  cliCommand: z.string(),
  cliCommandShell: z.literal('posix'),
});

export type AuthorizationReason = z.infer<typeof authorizationReasonSchema>;
export type AuthorizationMetadata = z.infer<typeof authorizationMetadataSchema>;

export interface BusinessResult<T> {
  status: 'ok' | 'authorization_required' | 'declined';
  result?: T;
  authorization?: AuthorizationMetadata;
}

function redactKnownSecrets(message: string): string {
  let sanitized = message;
  const secrets = [process.env.EMBEDDINGS_API_KEY, process.env.RERANK_API_KEY].filter(
    (value): value is string => Boolean(value),
  );

  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join('<redacted>');
  }

  return sanitized;
}

function sanitizeUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s'"<>]+/giu, (rawUrl) => {
    try {
      return new URL(rawUrl).origin;
    } catch {
      return '<redacted-url>';
    }
  });
}

function redactCredentialHeaders(message: string): string {
  return message
    .replace(
      /\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/giu,
      '$1=<redacted>',
    )
    .replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]*/giu, '$1=<redacted>');
}

export function sanitizeSensitiveText(
  message: string,
  options?: { preserveLineBreaks?: boolean },
): string {
  const withoutHeaders = redactCredentialHeaders(redactKnownSecrets(message));
  const sanitized = sanitizeUrls(withoutHeaders).replace(
    /\b(api[_-]?key|authorization|password|token)\s*[:=]\s*[^\s,;]+/giu,
    '$1=<redacted>',
  );
  return replaceControlCharacters(sanitized, options?.preserveLineBreaks);
}

export function sanitizeErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeSensitiveText(rawMessage).trim();
  return (sanitized || 'MCP 工具执行失败').slice(0, 1000);
}

export function toBusinessToolResult<T>(payload: BusinessResult<T>): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

export function toErrorToolResult(error: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: sanitizeErrorMessage(error) }],
    isError: true,
  };
}
