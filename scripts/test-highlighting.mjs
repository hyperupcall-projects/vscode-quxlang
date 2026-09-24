#!/usr/bin/env node
/**
 * Tokenize real Quxlang sources with the TextMate grammar and check scopes.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vsctm = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const grammarPath = join(root, "syntaxes", "quxlang.tmLanguage.json");
const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");

function findQuxlangRoot() {
  const candidates = [
    process.env.QUXLANG_ROOT,
    join(root, "..", "quxlang"),
    join(root, "..", "..", "quxlang"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(join(candidate, "quxlang"))) {
      return candidate;
    }
    if (existsSync(join(candidate, "website", "docs"))) {
      return candidate;
    }
  }
  throw new Error("Could not find the cloned quxlang repository. Set QUXLANG_ROOT.");
}

function collectQxs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      collectQxs(path, out);
    } else if (name.endsWith(".qxs")) {
      out.push(path);
    }
  }
  return out;
}

async function loadGrammar() {
  const wasmBin = readFileSync(wasmPath);
  await oniguruma.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName) => {
      if (scopeName !== "source.quxlang") return null;
      return vsctm.parseRawGrammar(readFileSync(grammarPath, "utf8"), grammarPath);
    },
  });
  const grammar = await registry.loadGrammar("source.quxlang");
  if (!grammar) throw new Error("Failed to load source.quxlang");
  return grammar;
}

function tokenize(grammar, source) {
  const lines = source.split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  return lines.map((line) => {
    const { tokens, ruleStack: next } = grammar.tokenizeLine(line, ruleStack);
    ruleStack = next;
    return tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      start: token.startIndex,
      end: token.endIndex,
      scopes: token.scopes,
    }));
  });
}

function firstToken(lineTokens, text) {
  return (
    lineTokens.find((token) => token.text === text)
    || lineTokens.find((token) => token.text.includes(text))
    || lineTokens.find((token) => text.startsWith(token.text) && token.text.trim().length > 0)
  );
}

function hasScope(token, fragment) {
  return token && token.scopes.some((scope) => scope.includes(fragment));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkGolden(grammar) {
  const source = `LANGUAGE QUXLANG EN 0.0;

IMPORT std;

::clamp FUNCTION(@value I32, @minimum I32, @maximum I32): I32
{
  IF (value < minimum)
  {
    RETURN minimum; // Number of items
  }
  RETURN value;
}

::point STRUCT
{
  .x VAR I32;
  .CONSTRUCTOR FUNCTION(@x I32) { .x := x; }
}

::runtime_case UNIT_TEST
{
  VAR message STRING_CONSTANT := "line one\\nline two";
  VAR newline BYTE := '\\n';
  VAR fraction F64 := 12.5;
  ASSERT(TRUE);
  TEST_ASSERT(named#(@offset 7, @factor 3)(@value 5) == 22);
}

DOC <$ Returns twice the supplied value. $>
::double INCLUDE_IF(OS_LINUX) FUNCTION(@ARG:value I32): I32
{
  RETURN value * 2;
}

::linux_exit INCLUDE_IF(OS_LINUX) ASM_PROCEDURE X64
  CALLABLE(@code I32; RETURN I32)
{
  MOV RAX, 60
  SYSCALL
  RET
}
`;

  const lines = tokenize(grammar, source);
  const cases = [
    [0, "LANGUAGE", "keyword.control"],
    [0, "QUXLANG", "entity.name.type"],
    [0, "EN", "constant.language"],
    [0, "0.0", "constant.numeric"],
    [2, "IMPORT", "keyword.control"],
    [2, "std", "variable.other"],
    [4, "clamp", "entity.name.function"],
    [4, "FUNCTION", "storage.type"],
    [4, "@", "punctuation.definition.parameter"],
    [4, "value", "variable.parameter"],
    [4, "I32", "support.type.primitive"],
    [6, "IF", "keyword.control"],
    [6, "value", "variable.other"],
    [8, "RETURN", "keyword.control"],
    [8, "// Number of items", "comment.line.double-slash"],
    [13, "point", "entity.name.type"],
    [13, "STRUCT", "storage.type"],
    [15, "x", "variable.other"],
    [15, "VAR", "storage.type.variable"],
    [16, "CONSTRUCTOR", "support.function.special-member"],
    [19, "runtime_case", "entity.name.function"],
    [19, "UNIT_TEST", "storage.type"],
    [21, "STRING_CONSTANT", "support.type.builtin"],
    [21, "\\n", "constant.character.escape"],
    [22, "BYTE", "support.type.builtin"],
    [22, "\\n", "constant.character.escape"],
    [23, "F64", "support.type.primitive"],
    [23, "12.5", "constant.numeric"],
    [24, "ASSERT", "support.function.assert"],
    [24, "TRUE", "constant.language"],
    [25, "named", "entity.name.function.call"],
    [25, "#", "keyword.operator.template"],
    [28, "DOC", "storage.modifier.doc"],
    [28, "Returns twice the supplied value.", "comment.block.documentation"],
    [29, "INCLUDE_IF", "storage.modifier"],
    [29, "OS_LINUX", "constant.language.target"],
    [29, "ARG", "variable.parameter"],
    [29, "value", "variable.parameter.binding"],
    [34, "linux_exit", "entity.name.function"],
    [34, "ASM_PROCEDURE", "storage.type"],
    [34, "X64", "constant.language.target"],
    [35, "CALLABLE", "storage.type"],
    [37, "MOV", "keyword.other.instruction.asm"],
    [37, "RAX", "variable.language.register.asm"],
    [37, "60", "constant.numeric"],
  ];

  const failures = [];
  for (const [line, text, scope] of cases) {
    const token = firstToken(lines[line], text);
    if (!token) {
      failures.push(`line ${line + 1}: missing token ${JSON.stringify(text)}\n  tokens: ${lines[line].map((t) => JSON.stringify(t.text)).join(" | ")}`);
      continue;
    }
    if (!hasScope(token, scope)) {
      failures.push(`line ${line + 1}: ${JSON.stringify(text)} expected scope containing ${scope}, got ${token.scopes.join(", ")}`);
    }
  }
  if (failures.length) {
    throw new Error(failures.join("\n"));
  }
}

function classifyScopes(scopes) {
  const joined = scopes.join(" ");
  if (
    joined.includes("keyword")
    || joined.includes("storage.")
    || joined.includes("support.type")
    || joined.includes("support.function")
    || joined.includes("constant.language")
    || joined.includes("variable.language")
    || joined.includes("entity.name.type")
  ) {
    return "keywordish";
  }
  if (joined.includes("comment")) return "comment";
  if (joined.includes("string")) return "string";
  if (joined.includes("constant.numeric") || joined.includes("constant.character")) return "literal";
  if (joined.includes("entity.name") || joined.includes("variable.") || joined.includes("punctuation") || joined.includes("invalid")) {
    return "name";
  }
  return "other";
}

function checkCorpus(grammar, files, repoRoot) {
  const keywordish = /^(LANGUAGE|QUXLANG|IMPORT|FUNCTION|STRUCT|CLASS|NAMESPACE|ENUM|FLAGSET|VAR|STATIC|IF|ELSE|UNLESS|LOOP|WHILE|DO|RETURN|TRUE|FALSE|BOOL|BYTE|VOID|I32|U64|F64|STRING_CONSTANT|INCLUDE_IF|ASM_PROCEDURE|UNIT_TEST|DUAL_TEST|STATIC_TEST|TEMPLATE|DOC)$/;
  const failures = [];
  let filesChecked = 0;
  let tokensChecked = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = tokenize(grammar, source);
    filesChecked += 1;
    const rel = relative(repoRoot, file);

    lines.forEach((lineTokens, index) => {
      for (const token of lineTokens) {
        if (!token.text.trim()) continue;
        tokensChecked += 1;
        if (keywordish.test(token.text)) {
          if (classifyScopes(token.scopes) !== "keywordish") {
            failures.push(`${rel}:${index + 1}: ${JSON.stringify(token.text)} should be a keyword, scopes=${token.scopes.join(" ")}`);
          }
        } else if (token.text.startsWith("//")) {
          if (!hasScope(token, "comment")) {
            failures.push(`${rel}:${index + 1}: comment not scoped: ${JSON.stringify(token.text)}`);
          }
        } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(token.text) && !token.scopes.some((s) => s.includes("comment") || s.includes("string"))) {
          if (!hasScope(token, "constant.numeric")) {
            failures.push(`${rel}:${index + 1}: number not scoped: ${JSON.stringify(token.text)} ${token.scopes.join(" ")}`);
          }
        }
      }
    });

    if (!source.includes("LANGUAGE QUXLANG")) continue;
    const first = lines[0] || [];
    const language = firstToken(first, "LANGUAGE") || first.find((t) => t.text.includes("LANGUAGE"));
    if (source.trimStart().startsWith("LANGUAGE") && language && !hasScope(language, "keyword")) {
      failures.push(`${rel}:1: LANGUAGE header not highlighted`);
    }
  }

  if (failures.length) {
    const preview = failures.slice(0, 20).join("\n");
    throw new Error(`${failures.length} corpus highlighting failures\n${preview}`);
  }

  return { filesChecked, tokensChecked };
}

const grammar = await loadGrammar();
checkGolden(grammar);
const repoRoot = findQuxlangRoot();
const files = collectQxs(repoRoot);
if (files.length < 50) {
  throw new Error(`Expected dozens of .qxs files in ${repoRoot}, found ${files.length}`);
}
const { filesChecked, tokensChecked } = checkCorpus(grammar, files, repoRoot);
console.log(`Unofficial Quxlang TextMate: golden scopes passed`);
console.log(`Checked ${filesChecked} .qxs files (${tokensChecked} tokens) under ${repoRoot}`);
