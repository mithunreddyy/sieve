import type { GrammarId } from "./grammars.ts";

/**
 * Declaration queries per language. Each entry is compiled on its own, so a node type a
 * grammar version lacks drops only that entry. Every pattern captures @def (the whole
 * declaration, for its line range) and @name.
 */
const JS_COMMON = [
  "(class_declaration name: (_) @name) @def",
  "(method_definition name: (_) @name) @def",
  "(function_declaration name: (_) @name) @def",
  "(generator_function_declaration name: (_) @name) @def",
  "(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (class)])) @def",
  "(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (class)])) @def",
  // Top-level consts of any value (objects, arrays, calls): extractor tables, configs, schemas.
  "(program (lexical_declaration (variable_declarator name: (identifier) @name)) @def)",
  "(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @def)",
];
const TS_EXTRA = [
  "(abstract_class_declaration name: (_) @name) @def",
  "(interface_declaration name: (_) @name) @def",
  "(type_alias_declaration name: (_) @name) @def",
  "(enum_declaration name: (_) @name) @def",
  "(internal_module name: (_) @name) @def",
  "(abstract_method_signature name: (_) @name) @def",
];

export const QUERIES: Record<GrammarId, string[]> = {
  typescript: [...JS_COMMON, ...TS_EXTRA],
  tsx: [...JS_COMMON, ...TS_EXTRA],
  javascript: JS_COMMON,
  python: ["(class_definition name: (_) @name) @def", "(function_definition name: (_) @name) @def"],
  go: [
    "(function_declaration name: (_) @name) @def",
    "(method_declaration name: (_) @name) @def",
    "(type_declaration (type_spec name: (_) @name)) @def",
  ],
  rust: [
    "(function_item name: (_) @name) @def",
    "(struct_item name: (_) @name) @def",
    "(enum_item name: (_) @name) @def",
    "(trait_item name: (_) @name) @def",
    "(impl_item type: (_) @name) @def",
    "(mod_item name: (_) @name) @def",
    "(macro_definition name: (_) @name) @def",
    "(type_item name: (_) @name) @def",
  ],
  java: [
    "(class_declaration name: (_) @name) @def",
    "(interface_declaration name: (_) @name) @def",
    "(enum_declaration name: (_) @name) @def",
    "(record_declaration name: (_) @name) @def",
    "(method_declaration name: (_) @name) @def",
    "(constructor_declaration name: (_) @name) @def",
  ],
  csharp: [
    "(namespace_declaration name: (_) @name) @def",
    "(class_declaration name: (_) @name) @def",
    "(interface_declaration name: (_) @name) @def",
    "(struct_declaration name: (_) @name) @def",
    "(enum_declaration name: (_) @name) @def",
    "(record_declaration name: (_) @name) @def",
    "(method_declaration name: (_) @name) @def",
    "(constructor_declaration name: (_) @name) @def",
  ],
  cpp: [
    "(function_definition declarator: (function_declarator declarator: (_) @name)) @def",
    "(class_specifier name: (_) @name body: (_)) @def",
    "(struct_specifier name: (_) @name body: (_)) @def",
    "(enum_specifier name: (_) @name body: (_)) @def",
    "(namespace_definition name: (_) @name) @def",
  ],
  ruby: [
    "(class name: (_) @name) @def",
    "(module name: (_) @name) @def",
    "(method name: (_) @name) @def",
    "(singleton_method name: (_) @name) @def",
  ],
  php: [
    "(class_declaration name: (_) @name) @def",
    "(interface_declaration name: (_) @name) @def",
    "(trait_declaration name: (_) @name) @def",
    "(function_definition name: (_) @name) @def",
    "(method_declaration name: (_) @name) @def",
  ],
  bash: ["(function_definition name: (_) @name) @def"],
};

const EXT: Record<string, GrammarId | "markdown"> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
};

export function languageFor(path: string): GrammarId | "markdown" | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? (EXT[m[1]!.toLowerCase()] ?? null) : null;
}

const KIND_ALIASES = new Map([
  ["lexical", "function"], // the queries only match function- or class-valued declarations
  ["variable", "function"],
  ["type_alias", "type"],
  ["internal_module", "namespace"],
  ["type_spec", "type"],
]);

/** Kind label from a tree-sitter node type, e.g. "method_definition" → "method". */
export function kindOf(nodeType: string): string {
  const t = nodeType
    .replace(/_(declaration|definition|item|specifier|statement|signature)$/, "")
    .replace(/^(abstract|generator|internal|singleton)_/, "");
  // A Map, not an object literal: "constructor" must not resolve to Object.prototype.constructor.
  return KIND_ALIASES.get(t) ?? t.replace(/_/g, " ");
}
