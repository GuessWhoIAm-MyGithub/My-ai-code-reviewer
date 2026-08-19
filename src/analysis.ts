import { File, Change } from "parse-diff";

// Pure cross-file analysis helpers: import heuristics, diff rendering, and
// review-batch grouping. No IO here so everything is directly testable.

// Repo files scanned for reverse references (callers) per batch
export const MAX_REFERENCE_CANDIDATES = 30;
// Unchanged related files actually included per batch
export const MAX_REFERENCES_PER_BATCH = 6;

// Rough heuristic for code/diff content: ~4 characters per token
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Import extraction -------------------------------------------------------

const JS_IMPORT_RES = [
  /import\s[^;'"()]*?from\s*['"]([^'"]+)['"]/g,
  /export\s[^;'"()]*?from\s*['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const PY_IMPORT_RES = [
  /^\s*from\s+([.\w]+)\s+import\s+/gm,
  /^\s*import\s+([.\w]+)/gm,
];
const JVM_IMPORT_RES = [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm];
const SWIFT_IMPORT_RES = [/(?:@testable\s+)?import\s+([A-Za-z_][A-Za-z0-9_]*)/g];
// C/C++ quoted includes only: angle brackets are system/SDK headers
const C_INCLUDE_RES = [/#\s*include\s*"([^"]+)"/g];
// Swift links files by symbol references, not file imports; type names
// declared on changed lines identify what nearby files may be using
const SWIFT_DECLARATION_RES =
  /\b(?:struct|class|enum|protocol|actor|extension|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

export function languageOf(
  path: string
): "js" | "python" | "go" | "jvm" | "swift" | "c" | "unknown" {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte"].includes(ext))
    return "js";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (["java", "kt", "kts"].includes(ext)) return "jvm";
  if (ext === "swift") return "swift";
  if (["c", "h", "cpp", "hpp", "cc", "cxx"].includes(ext)) return "c";
  return "unknown";
}

export function extractImportSpecifiers(
  filePath: string,
  content: string
): string[] {
  const lang = languageOf(filePath);
  const specs: string[] = [];
  const collect = (re: RegExp) => {
    for (const m of content.matchAll(re)) if (m[1]) specs.push(m[1]);
  };
  if (lang === "js") {
    JS_IMPORT_RES.forEach(collect);
  } else if (lang === "python") {
    PY_IMPORT_RES.forEach(collect);
  } else if (lang === "go") {
    // Only strings inside import blocks count, so arbitrary string literals
    // are not mistaken for imports
    for (const block of content.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
      for (const q of block[1].matchAll(/"([^"]+)"/g)) specs.push(q[1]);
    }
    collect(/(?:^|\n)import\s+"([^"]+)"/g);
  } else if (lang === "jvm") {
    JVM_IMPORT_RES.forEach(collect);
  } else if (lang === "swift") {
    SWIFT_IMPORT_RES.forEach(collect);
  } else if (lang === "c") {
    C_INCLUDE_RES.forEach(collect);
  }
  return [...new Set(specs)];
}

function normalizeRepoPath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// Resolve an import specifier against a set of known repo paths. Returns the
// matched path, or null for bare package imports (node_modules, stdlib, ...).
export function resolveImportSpecifier(
  fromPath: string,
  spec: string,
  candidatePaths: Set<string>
): string | null {
  const lang = languageOf(fromPath);

  if (lang === "go" || lang === "jvm") {
    // Module-path style imports matched by path suffix, each with its own
    // direction: Go module paths ("github.com/org/repo/pkg") contain the
    // repo-relative package dir; JVM class imports ("a.b.C") match the file
    // path; JVM wildcard imports ("a.b.*") name a package that the
    // candidate's directory must end with.
    const wildcard = /\.\*$/.test(spec);
    const dotted = spec.replace(/\.\*$/, "").replace(/\./g, "/");
    const dirOf = (p: string) =>
      p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    for (const p of candidatePaths) {
      if (lang === "go") {
        const dir = dirOf(p);
        if (dir && (dotted === dir || dotted.endsWith("/" + dir))) return p;
      } else if (wildcard) {
        const dir = dirOf(p);
        if (dir && (dir === dotted || dir.endsWith("/" + dotted))) return p;
      } else {
        const noExt = p.replace(/\.[^.]+$/, "");
        if (noExt === dotted || noExt.endsWith("/" + dotted)) return p;
      }
    }
    return null;
  }

  if (lang === "python" && spec.startsWith(".")) {
    // Python relative import: the first dot means the containing package,
    // each additional dot goes up one level ("..sib.mod" → ../sib/mod.py)
    const dots = spec.match(/^[.]*/)![0].length;
    const rest = spec.slice(dots).replace(/\./g, "/");
    let base = fromPath.includes("/")
      ? fromPath.slice(0, fromPath.lastIndexOf("/"))
      : "";
    for (let u = 1; u < dots; u++) {
      base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    }
    const joined = normalizeRepoPath(base + "/" + rest);
    for (const tail of ["", ".py", "/__init__.py"]) {
      if (candidatePaths.has(joined + tail)) return joined + tail;
    }
    return null;
  }

  if (lang === "c") {
    // Quoted includes resolve against the includer's directory and the repo
    // root; fall back to a path-suffix match (components expose their own
    // include dirs, so "driver/gpio.h" may live anywhere in the tree)
    const bases = [
      fromPath.includes("/")
        ? fromPath.slice(0, fromPath.lastIndexOf("/")) + "/"
        : "",
      "",
    ];
    for (const base of bases) {
      const p = normalizeRepoPath(base + spec);
      if (candidatePaths.has(p)) return p;
    }
    for (const p of candidatePaths) {
      if (p === spec || p.endsWith("/" + spec)) return p;
    }
    return null;
  }

  if (lang === "swift") {
    // Only local SPM modules resolve to repo paths: "import MyKit" links to
    // the target's sources directory; system frameworks (SwiftUI, ...) never
    // match repo files
    for (const p of candidatePaths) {
      const target = p.match(/(?:^|\/)Sources\/([^/]+)\//);
      if (target && target[1] === spec) return p;
    }
    return null;
  }

  if (spec.startsWith(".")) {
    // Relative specifier (JS/TS)
    const base = fromPath.includes("/")
      ? fromPath.slice(0, fromPath.lastIndexOf("/"))
      : "";
    const joined = normalizeRepoPath(`${base}/${spec}`);
    for (const tail of [
      "",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      "/index.ts",
      "/index.tsx",
      "/index.js",
      "/index.jsx",
      "/__init__.py",
    ]) {
      if (candidatePaths.has(joined + tail)) return joined + tail;
    }
    return null;
  }

  if (lang === "python") {
    // Absolute module path: resolve against the repo root and the importer's
    // own directory (implicit namespace packages)
    const mod = spec.replace(/\./g, "/");
    const bases = [
      "",
      fromPath.includes("/")
        ? fromPath.slice(0, fromPath.lastIndexOf("/")) + "/"
        : "",
    ];
    for (const base of bases) {
      for (const tail of [".py", "/__init__.py"]) {
        const p = normalizeRepoPath(base + mod + tail);
        if (candidatePaths.has(p)) return p;
      }
    }
  }
  return null;
}

// --- Symbol-reference linkage (Swift and other module-scoped languages) ----
// Swift files in the same module reference each other by type name with no
// import statement, so declared type names on changed lines are the linkage
// signal for finding unchanged callers.

export function extractDeclaredSymbols(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(SWIFT_DECLARATION_RES)) {
    const name = m[1];
    // Uppercase-initial names of decent length: types are the cross-file
    // contract in Swift; lowercase members (body, name, ...) are ubiquitous
    if (/^[A-Z]/.test(name) && name.length >= 4) names.add(name);
  }
  return [...names].slice(0, 80);
}

export function referencesAnySymbol(
  content: string,
  symbols: string[]
): boolean {
  if (symbols.length === 0) return false;
  return new RegExp(`\\b(?:${symbols.join("|")})\\b`).test(content);
}

// Correct model-claimed "related file" paths against the paths the model
// actually saw (batch files, PR changed files, reference files): exact match
// first, then path-suffix, then basename with the closest directory. Claims
// that match nothing the model could have seen are dropped — the anchor file
// is validated separately and relatedFiles is informational.
export function correctRelatedPaths(
  claimed: string[],
  knownPaths: string[]
): string[] {
  const known = new Set(knownPaths);
  const corrected: string[] = [];
  for (const raw of claimed) {
    const path = raw.trim();
    if (!path) continue;
    let match: string | undefined;
    if (known.has(path)) {
      match = path;
    } else {
      const bySuffix = [...known].filter((k) => k.endsWith("/" + path));
      if (bySuffix.length > 0) {
        match = bySuffix.sort((a, b) => a.length - b.length)[0];
      } else {
        const base = path.split("/").pop()!;
        const byBase = knownPaths.filter(
          (k) => k.split("/").pop() === base
        );
        if (byBase.length > 0) {
          // closest directory wins; ties break alphabetically for determinism
          match = byBase
            .map((k) => ({ k, depth: sharedDirDepth(k, path) }))
            .sort((a, b) => b.depth - a.depth || a.k.localeCompare(b.k))[0].k;
        }
      }
    }
    if (match && !corrected.includes(match)) corrected.push(match);
  }
  return corrected;
}

// --- Diff rendering ----------------------------------------------------------

export function getNewFileLineNumber(change: Change): number | null {
  switch (change.type) {
    case "add":
      return change.ln;
    case "normal":
      return change.ln2;
    case "del":
      return null; // deleted lines don't exist in the new file
  }
}

function formatChange(change: Change): string {
  const newLine = getNewFileLineNumber(change);
  const lineLabel = newLine != null ? String(newLine) : "-";
  const prefix =
    change.type === "add" ? "+" : change.type === "del" ? "-" : " ";
  // change.content already has +/- prefix from parse-diff, strip it for clean formatting
  const content =
    change.content.startsWith("+") || change.content.startsWith("-")
      ? change.content.slice(1)
      : change.content;
  return `${lineLabel} ${prefix} ${content}`;
}

export function formatFileDiff(file: File): string {
  return file.chunks
    .map((chunk) => {
      const header = chunk.content;
      const lines = chunk.changes.map(formatChange).join("\n");
      return `${header}\n${lines}`;
    })
    .join("\n\n");
}

// --- Review batching ---------------------------------------------------------

// Group changed files into review batches: files linked by imports belong to
// the same call so the model can check cross-file consistency. Oversized
// groups are split, evicting the least-connected files first.
export function buildReviewGroups(
  files: File[],
  importsOf: Map<string, Set<string>>,
  budget: number
): File[][] {
  const diffTokensOf = (f: File) => estimateTokens(formatFileDiff(f));
  const groupTokens = (g: File[]) => g.reduce((s, f) => s + diffTokensOf(f), 0);

  // Union-find over import edges between changed files
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const f of files) parent.set(f.to!, f.to!);
  for (const [path, deps] of importsOf) {
    for (const dep of deps) {
      if (parent.has(dep)) union(path, dep);
    }
  }
  const components = new Map<string, File[]>();
  for (const f of files) {
    const root = find(f.to!);
    const arr = components.get(root) ?? [];
    arr.push(f);
    components.set(root, arr);
  }

  // Merge components: same directory first (most likely related), then any
  // remaining groups while the combined diffs still fit the budget
  const dirOf = (p: string) =>
    p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const groups = [...components.values()].sort(
    (a, b) =>
      dirOf(a[0].to!).localeCompare(dirOf(b[0].to!)) ||
      groupTokens(b) - groupTokens(a)
  );
  const merged: File[][] = [];
  for (const g of groups) {
    const target = merged.find(
      (m) =>
        groupTokens(m) + groupTokens(g) <= budget &&
        dirOf(m[0].to!) === dirOf(g[0].to!)
    );
    if (target) target.push(...g);
    else merged.push([...g]);
  }
  for (let i = 0; i < merged.length; i++) {
    for (let j = merged.length - 1; j > i; j--) {
      if (groupTokens(merged[i]) + groupTokens(merged[j]) <= budget) {
        merged[i].push(...merged[j]);
        merged.splice(j, 1);
      }
    }
  }

  // Split any group still over budget: repeatedly evict the file with the
  // fewest import links to the rest (largest diff breaks ties), keeping the
  // tightly-coupled core together. Evicted files form a spill group that is
  // itself split recursively.
  const result: File[][] = [];
  const intraLinks = (f: File, g: File[]): number => {
    const deps = importsOf.get(f.to!) ?? new Set<string>();
    const outgoing = [...deps].filter((d) => g.some((o) => o.to === d)).length;
    const incoming = g.filter((o) =>
      (importsOf.get(o.to!) ?? new Set<string>()).has(f.to!)
    ).length;
    return outgoing + incoming;
  };
  const pickVictim = (g: File[]): File =>
    g.reduce((worst, f) => {
      const score = (c: File) => intraLinks(c, g) * 1e9 - diffTokensOf(c);
      return score(f) < score(worst) ? f : worst;
    }, g[0]);
  const splitGroup = (g: File[]): File[][] => {
    if (g.length === 1 || groupTokens(g) <= budget) return [g];
    const spill: File[] = [];
    let current = [...g];
    while (current.length > 1 && groupTokens(current) > budget) {
      const victim = pickVictim(current);
      current = current.filter((f) => f !== victim);
      spill.push(victim);
    }
    return [...splitGroup(current), ...(spill.length ? splitGroup(spill) : [])];
  };
  for (const g of merged) result.push(...splitGroup(g));
  return result;
}

function sharedDirDepth(a: string, b: string): number {
  const sa = a.split("/").slice(0, -1);
  const sb = b.split("/").slice(0, -1);
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return i;
}

// Nearby same-language repo files that may import the batch files, nearest by
// shared directory first; capped to bound the number of getContent calls.
export function selectCallerCandidates(
  batchPaths: string[],
  repoTree: string[],
  changedPaths: Set<string>
): string[] {
  const batchLanguages = new Set(
    batchPaths.map(languageOf).filter((l) => l !== "unknown")
  );
  const scored: Array<{ path: string; depth: number }> = [];
  for (const path of repoTree) {
    if (changedPaths.has(path)) continue;
    const lang = languageOf(path);
    if (lang === "unknown" || !batchLanguages.has(lang)) continue;
    const depth = Math.max(...batchPaths.map((b) => sharedDirDepth(path, b)));
    if (depth >= 1) scored.push({ path, depth });
  }
  scored.sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_REFERENCE_CANDIDATES).map((s) => s.path);
}

// One line per changed file (+adds/-dels), shown in every batch prompt so the
// model knows the full scope of the PR even when it spans several batches.
export function summarizeChangedFiles(files: File[]): string {
  return files
    .map((f) => {
      let add = 0;
      let del = 0;
      for (const chunk of f.chunks) {
        for (const change of chunk.changes) {
          if (change.type === "add") add++;
          else if (change.type === "del") del++;
        }
      }
      const path = f.to && f.to !== "/dev/null" ? f.to : `${f.from} (deleted)`;
      return `- ${path} (+${add}/-${del})`;
    })
    .join("\n");
}
