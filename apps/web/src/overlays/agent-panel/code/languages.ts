import { bundledLanguages } from "shiki/langs";

/** True when Shiki has a grammar for the language id or alias. Loads no grammar itself. */
export const isShikiLanguage = (language: string) =>
  Object.hasOwn(bundledLanguages, language.toLowerCase());
