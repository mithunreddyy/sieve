// Grammar files are embedded in the compiled binary (`with { type: "file" }`), so users
// need nothing installed. Source: @vscode/tree-sitter-wasm (MIT), which ships the runtime
// and grammars built together (ADR 0005).
import core from "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm" with { type: "file" };
import bash from "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm" with { type: "file" };
import csharp from "@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm" with { type: "file" };
import cpp from "@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm" with { type: "file" };
import go from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import java from "@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm" with { type: "file" };
import javascript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import php from "@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm" with { type: "file" };
import python from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import ruby from "@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm" with { type: "file" };
import rust from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };
import tsx from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import typescript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };

export const CORE_WASM: string = core;
export const GRAMMAR_FILES = {
  bash,
  csharp,
  cpp,
  go,
  java,
  javascript,
  php,
  python,
  ruby,
  rust,
  tsx,
  typescript,
} as const;
export type GrammarId = keyof typeof GRAMMAR_FILES;
