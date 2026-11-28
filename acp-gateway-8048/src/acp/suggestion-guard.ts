const SUGGESTION_MODE_MARKER = '[SUGGESTION MODE:';
const SUGGESTION_MODE_LINE_RE = /(?:^|\r?\n)\s*\[SUGGESTION MODE:/;

export interface SuggestionGuardPart {
  text?: string;
}

export interface SuggestionGuardContent {
  role?: string;
  parts?: SuggestionGuardPart[];
}

function extractContentText(content?: SuggestionGuardContent): string {
  if (!content || !Array.isArray(content.parts) || content.parts.length === 0) {
    return '';
  }
  let combined = '';
  for (const part of content.parts) {
    if (typeof part?.text === 'string' && part.text.length > 0) {
      combined += part.text;
    }
  }
  return combined;
}

export function isSuggestionModeText(text: string): boolean {
  return typeof text === 'string' && text.includes(SUGGESTION_MODE_MARKER);
}

export function isSuggestionModeRequest(contents?: SuggestionGuardContent[]): boolean {
  if (!Array.isArray(contents) || contents.length === 0) {
    return false;
  }

  const userMessages = contents.filter((c) => (c?.role ?? 'user') === 'user');
  if (userMessages.length === 0) {
    return false;
  }

  const firstText = extractContentText(userMessages[0]);
  const lastText = extractContentText(userMessages[userMessages.length - 1]);

  if (contents.length <= 2) {
    return SUGGESTION_MODE_LINE_RE.test(firstText) || SUGGESTION_MODE_LINE_RE.test(lastText);
  }

  return SUGGESTION_MODE_LINE_RE.test(lastText);
}
