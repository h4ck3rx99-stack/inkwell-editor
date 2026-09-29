import { z } from 'zod';
import { CATEGORIES, type Category } from '@/suggestions/model';

export const DIALECTS = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN'] as const;
export type Dialect = (typeof DIALECTS)[number];
export const DIALECT_LABEL: Record<Dialect, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'en-AU': 'English (Australia)',
  'en-CA': 'English (Canada)',
  'en-IN': 'English (India)',
};

export const GOALS = ['general', 'academic', 'business', 'casual', 'creative'] as const;
export type Goal = (typeof GOALS)[number];
export const GOAL_LABEL: Record<Goal, string> = {
  general: 'General',
  academic: 'Academic',
  business: 'Business',
  casual: 'Casual',
  creative: 'Creative',
};

export const SENSITIVITIES = ['conservative', 'balanced', 'thorough'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Minimum confidence a finding needs to be shown, per sensitivity. */
export const CONFIDENCE_THRESHOLD: Record<Sensitivity, number> = {
  conservative: 0.8,
  balanced: 0.6,
  thorough: 0.4,
};

/** Upper bound on suggestions per block from the AI tier. */
export const AI_ISSUE_CAP: Record<Sensitivity, number> = {
  conservative: 4,
  balanced: 8,
  thorough: 12,
};

export const CategoryTogglesSchema = z.object(
  Object.fromEntries(CATEGORIES.map((c) => [c, z.boolean()])) as Record<Category, z.ZodBoolean>,
);
export type CategoryToggles = Record<Category, boolean>;

export const SettingsSchema = z.object({
  dialect: z.enum(DIALECTS),
  sensitivity: z.enum(SENSITIVITIES),
  categories: CategoryTogglesSchema,
  localOnly: z.boolean(),
  theme: z.enum(THEMES),
  typewriterScrolling: z.boolean(),
  showIssuesPanel: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  dialect: 'en-US',
  sensitivity: 'balanced',
  categories: Object.fromEntries(CATEGORIES.map((c) => [c, true])) as CategoryToggles,
  localOnly: false,
  theme: 'system',
  typewriterScrolling: false,
  showIssuesPanel: false,
};

/** Per-document settings. */
export const DocSettingsSchema = z.object({
  aiEnabled: z.boolean(),
  goal: z.enum(GOALS),
});
export type DocSettings = z.infer<typeof DocSettingsSchema>;
export const DEFAULT_DOC_SETTINGS: DocSettings = { aiEnabled: true, goal: 'general' };

export function parseSettings(raw: unknown): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(typeof raw === 'object' && raw ? raw : {}) } as Record<string, unknown>;
  merged.categories = { ...DEFAULT_SETTINGS.categories, ...((merged.categories as object) ?? {}) };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** Normalize a word for the user dictionary (case-insensitive, straight apostrophes). */
export function normalizeDictionaryWord(word: string): string {
  return word.trim().replace(/[’‘]/g, "'").toLowerCase();
}
