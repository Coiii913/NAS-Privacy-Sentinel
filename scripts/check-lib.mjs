import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK_FORMAT_VERSION = "2.0.0";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCatalogPath = path.resolve(moduleDirectory, "../data/capability-catalog.json");
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skillNameMinCharacters = 2;
const skillNameMaxCharacters = 64;
const descriptionMaxCharacters = 1024;
const singleFileMaxBytes = 1024 * 1024;
const packageMaxBytes = 10 * 1024 * 1024;
const packageMaxFiles = 100;
const skillBodyRecommendedLines = 500;
const fullProfileCliAgents = new Map([
  ["ug-music", "media-agent"],
  ["ug-video", "media-agent"],
  ["ug-surveillance", "security-monitor-agent"],
  ["ug-filesystem", "file-agent"],
  ["ug-filemgr", "file-agent"],
  ["file-workflow", "file-agent"],
  ["ug-document", "document-agent"],
  ["ug-knowledge", "knowledge-agent"],
  ["ug-photo", "photo-agent"]
]);
const allowedAgents = new Set(fullProfileCliAgents.values());
const requiredStatusTokens = [
  "completed",
  "failed",
  "cancelled",
  "waiting_user",
  "waiting_approval"
];

const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const credentialAssignmentPattern = /\b(?:password|passwd|token|api[_-]?key|secret)\s*[:=]\s*["\x27][^"\x27\n]+["\x27]/i;
const remoteDownloadPattern = /\b(?:curl|wget)\b|https?:\/\/\S+\s*\|\s*(?:sh|bash)\b/i;
const runtimeFencePattern = /^```\s*(?:bash|sh|shell|python|py|javascript|js|node|typescript|ts)\b/i;
const directFileApiPattern = /\b(?:readFile|writeFile|unlink|pathlib|fs\.|open\s*\(|cp\s+|mv\s+|rm\s+|cat\s+)\b/i;
const httpCallPattern = /\b(?:fetch|axios|XMLHttpRequest|http\.request|https\.request)\s*\(/i;
const nasPathPattern = /(?:^|[\s"\x27])\/(?:nas|mnt|volume\d*|shares?)(?:\/|\b)/i;
const bypassPattern = /\b(?:bypass|skip|disable|ignore|绕过|跳过|关闭)\b[^\n]{0,40}\b(?:gateway|approval|permission|audit|审批|权限|审计)\b/i;
const descriptionTriggerPattern = /(?:当用户|用户(?:说|问|要|需要|希望|要求|提到)|适用于|使用于|用于|供[^，。;；]{1,40}使用|when\b|use when\b)/iu;
const descriptionExecutionDetailPattern = /(?:先[^，。;；]{0,24}(?:再|然后)|保存到|存到|输出到|按[^，。;；]{0,20}(?:排序|分组|归档)|不要|不得|不删除|只报告)/u;
const descriptionImperativePattern = /^\s*(?:生成|创建|整理出|产出|输出|汇总出|做一份|出一份)/u;
const hardcodedHomePattern = /\/home\/(?!<|\{|\$|某个?用户|用户名|user(?:name)?\b)[A-Za-z0-9._-]+(?:\/|\b)/i;
const unresolvedDynamicValuePattern = /<[^>\n]{1,80}>|(?:该路径|该目录|上一步(?:的)?(?:路径|目录|结果|文件|文本|内容|ID|标识)|刚才(?:的)?(?:结果|路径|目录|内容))/iu;
const queryIntentPattern = /(?:查询|查找|搜索|筛选|扫描|盘点|检索|列出|浏览|query|search|find|scan|filter|list|report)/iu;
const emptyResultHandlingPattern = /(?:空结果|空列表|空集合|无结果|无匹配(?:结果|项)?|没有匹配|没有找到|未找到|目录为空|返回为空|no results?|empty (?:result|list|set)|zero matches?)/iu;

function diagnostic(code, severity, message, suggestion, location = {}) {
  return { code, severity, ...location, message, suggestion };
}

function lineForOffset(source, offset) {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function characterCount(value) {
  return [...value].length;
}

function lineCount(value) {
  if (!value) return 0;
  return value.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sortDiagnostics(items) {
  const deduplicated = new Map();
  for (const item of items) {
    const key = [item.code, item.severity, item.file, item.line, item.path, item.message].join("|");
    if (!deduplicated.has(key)) deduplicated.set(key, item);
  }
  return [...deduplicated.values()].sort((left, right) => (
    (left.file ?? "").localeCompare(right.file ?? "")
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || left.code.localeCompare(right.code)
  ));
}

function finalizeResult({ target = {}, catalog = {}, files = [], diagnostics = [] }) {
  const orderedDiagnostics = sortDiagnostics(diagnostics);
  const summary = {
    errors: orderedDiagnostics.filter((item) => item.severity === "error").length,
    warnings: orderedDiagnostics.filter((item) => item.severity === "warning").length,
    info: orderedDiagnostics.filter((item) => item.severity === "info").length
  };
  const status = summary.errors > 0
    ? "not-uploadable"
    : summary.warnings > 0
      ? "static-pass-needs-target-validation"
      : "static-pass";
  return {
    checkFormatVersion: CHECK_FORMAT_VERSION,
    status,
    target,
    catalog,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
    summary,
    diagnostics: orderedDiagnostics
  };
}

async function loadCatalogContract(catalogPath) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (typeof catalog?.catalogVersion !== "string" || !Array.isArray(catalog?.clis)) {
    throw new Error("capability catalog has an invalid structure");
  }
  if (catalog.catalogVersion !== "2.0.0") {
    throw new Error("capability catalog version must be 2.0.0");
  }
  const cliAgents = new Map();
  for (const cli of catalog.clis) {
    if (typeof cli?.name !== "string" || typeof cli?.agent !== "string") {
      throw new Error("capability catalog has an invalid CLI ownership contract");
    }
    if (!allowedAgents.has(cli.agent)) {
      throw new Error("capability catalog references an unsupported full-profile subagent");
    }
    const expectedAgent = fullProfileCliAgents.get(cli.name);
    if (!expectedAgent || cli.agent !== expectedAgent) {
      throw new Error("capability catalog has an invalid full-profile CLI ownership mapping");
    }
    if (cliAgents.has(cli.name)) throw new Error("capability catalog has duplicate CLI names");
    cliAgents.set(cli.name, cli.agent);
  }
  if (cliAgents.size !== fullProfileCliAgents.size) {
    throw new Error("capability catalog has an incomplete full-profile CLI ownership mapping");
  }
  return { version: catalog.catalogVersion, cliAgents };
}

function targetError(code, message, suggestion) {
  return diagnostic(code, "error", message, suggestion);
}

function toPackagePath(parts) {
  return parts.join("/");
}

async function readMarkdownFile(absolutePath, packagePath, sources, files, diagnostics) {
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.size > singleFileMaxBytes) return;
    const source = await readFile(absolutePath, "utf8");
    if (source.includes("\0") || source.includes("\uFFFD")) {
      diagnostics.push(diagnostic(
        "RESOURCE_UNSUPPORTED",
        "error",
        "资源不是受支持的普通文本 Markdown。",
        "只保留可正常读取的 Markdown 文本资源。",
        { file: packagePath }
      ));
      return;
    }
    sources[packagePath] = source;
    files.push({ path: packagePath, sha256: sha256(source) });
  } catch {
    diagnostics.push(diagnostic(
      "TARGET_NOT_READABLE",
      "error",
      "目标文件不可读。",
      "修复文件读取权限后重新检查。",
      { file: packagePath }
    ));
  }
}

async function checkPackageLimits(rootDirectory) {
  const diagnostics = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(relativeParts) {
    const directory = path.join(rootDirectory, ...relativeParts);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      diagnostics.push(diagnostic(
        "TARGET_NOT_READABLE",
        "error",
        "Skill 包含不可读目录，无法完成包限制检查。",
        "修复目录读取权限后重新检查。",
        relativeParts.length > 0 ? { file: toPackagePath(relativeParts) } : {}
      ));
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const parts = [...relativeParts, entry.name];
      const packagePath = toPackagePath(parts);
      let metadata;
      try {
        metadata = await lstat(path.join(rootDirectory, ...parts));
      } catch {
        diagnostics.push(diagnostic("TARGET_NOT_READABLE", "error", "Skill 包含不可读项目。", "修复项目读取权限后重新检查。", { file: packagePath }));
        continue;
      }
      if (metadata.isDirectory()) {
        await visit(parts);
        continue;
      }

      fileCount += 1;
      totalBytes += metadata.size;
      if (metadata.size > singleFileMaxBytes) {
        diagnostics.push(diagnostic(
          "PACKAGE_FILE_SIZE_EXCEEDED",
          "error",
          `单文件大小超限（当前 ${metadata.size} 字节，上限 ${singleFileMaxBytes} 字节）。`,
          "压缩或拆分该文件，使单文件不超过 1 MB。",
          { file: packagePath }
        ));
      }
    }
  }

  await visit([]);
  if (fileCount > packageMaxFiles) {
    diagnostics.push(diagnostic(
      "PACKAGE_FILE_COUNT_EXCEEDED",
      "error",
      `Skill 文件数量超限（当前 ${fileCount} 个，上限 ${packageMaxFiles} 个）。`,
      "删除不必要文件或合并参考内容，使文件数量不超过 100 个。"
    ));
  }
  if (totalBytes > packageMaxBytes) {
    diagnostics.push(diagnostic(
      "PACKAGE_TOTAL_SIZE_EXCEEDED",
      "error",
      `Skill 总包大小超限（当前 ${totalBytes} 字节，上限 ${packageMaxBytes} 字节）。`,
      "压缩或删除不必要内容，使总包大小不超过 10 MB。"
    ));
  }
  return diagnostics;
}

async function walkReferences(rootDirectory, relativeParts, sources, files, diagnostics) {
  const absoluteDirectory = path.join(rootDirectory, ...relativeParts);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    diagnostics.push(diagnostic(
      "TARGET_NOT_READABLE",
      "error",
      "references 目录不可读。",
      "修复目录读取权限后重新检查。",
      { file: toPackagePath(relativeParts) }
    ));
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const parts = [...relativeParts, entry.name];
    const packagePath = toPackagePath(parts);
    const absolutePath = path.join(rootDirectory, ...parts);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      diagnostics.push(diagnostic("TARGET_NOT_READABLE", "error", "资源不可读。", "修复资源读取权限。", { file: packagePath }));
      continue;
    }
    if (metadata.isSymbolicLink()) {
      diagnostics.push(diagnostic("RESOURCE_PATH_INVALID", "error", "references 不允许符号链接。", "改为包内普通 Markdown 文件。", { file: packagePath }));
      continue;
    }
    if (metadata.isDirectory()) {
      await walkReferences(rootDirectory, parts, sources, files, diagnostics);
      continue;
    }
    if (!metadata.isFile() || !entry.name.endsWith(".md")) {
      diagnostics.push(diagnostic("RESOURCE_UNSUPPORTED", "error", "references 只允许普通 Markdown 文件。", "删除脚本、可执行文件、二进制或其他扩展名资源。", { file: packagePath }));
      continue;
    }
    await readMarkdownFile(absolutePath, packagePath, sources, files, diagnostics);
  }
}

async function readTarget(targetDirectory, catalogVersion) {
  const diagnostics = [];
  const files = [];
  const sources = {};
  let targetMetadata;
  try {
    targetMetadata = await lstat(targetDirectory);
  } catch (error) {
    const code = error?.code === "ENOENT" ? "TARGET_NOT_FOUND" : "TARGET_NOT_READABLE";
    const message = code === "TARGET_NOT_FOUND" ? "目标 Skill 目录不存在。" : "目标 Skill 目录不可读。";
    return { earlyResult: finalizeResult({ catalog: { checkedVersion: catalogVersion }, diagnostics: [targetError(code, message, "提供一个存在且可读的 Skill 目录。")] }) };
  }
  if (!targetMetadata.isDirectory()) {
    return { earlyResult: finalizeResult({ catalog: { checkedVersion: catalogVersion }, diagnostics: [targetError("TARGET_NOT_DIRECTORY", "检查目标不是目录。", "提供包含 SKILL.md 的目录。")] }) };
  }

  let entries;
  try {
    entries = await readdir(targetDirectory, { withFileTypes: true });
  } catch {
    return { earlyResult: finalizeResult({ catalog: { checkedVersion: catalogVersion }, diagnostics: [targetError("TARGET_NOT_READABLE", "目标 Skill 目录不可读。", "修复目录读取权限后重新检查。")] }) };
  }

  const names = new Set(entries.map((entry) => entry.name));
  diagnostics.push(...await checkPackageLimits(targetDirectory));
  if (!names.has("SKILL.md")) {
    diagnostics.push(diagnostic("FILE_REQUIRED_MISSING", "error", "缺少唯一必需入口 SKILL.md。", "在 Skill 根目录添加 SKILL.md。", { file: "SKILL.md" }));
  }

  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue;
    if (entry.name === "references" && entry.isDirectory()) continue;
    const packagePath = entry.name;
    const metadata = await lstat(path.join(targetDirectory, entry.name));
    diagnostics.push(diagnostic(
      metadata.isSymbolicLink() ? "RESOURCE_PATH_INVALID" : "RESOURCE_UNSUPPORTED",
      "error",
      "Skill 根目录只允许 SKILL.md 和 references/。",
      "删除 manifest、sidecar、脚本、二进制和其他根级项目。",
      { file: packagePath }
    ));
  }

  if (names.has("SKILL.md")) {
    const skillPath = path.join(targetDirectory, "SKILL.md");
    const metadata = await lstat(skillPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      diagnostics.push(diagnostic("RESOURCE_PATH_INVALID", "error", "SKILL.md 必须是普通文件。", "使用包内普通 Markdown 文件。", { file: "SKILL.md" }));
    } else {
      await readMarkdownFile(skillPath, "SKILL.md", sources, files, diagnostics);
    }
  }
  if (names.has("references")) {
    const referencesPath = path.join(targetDirectory, "references");
    const metadata = await lstat(referencesPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      diagnostics.push(diagnostic("RESOURCE_PATH_INVALID", "error", "references 必须是包内普通目录。", "删除符号链接或同名非目录项目。", { file: "references" }));
    } else {
      await walkReferences(targetDirectory, ["references"], sources, files, diagnostics);
    }
  }
  return { sources, files, diagnostics };
}

function parseFrontmatter(source) {
  const issues = [];
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { value: null, body: source, issues: [diagnostic("SKILL_FRONTMATTER_INVALID", "error", "SKILL.md 缺少有效的起始 frontmatter。", "在文件开头使用 --- 包围 name 和 description。", { file: "SKILL.md", line: 1 })] };
  }
  const value = {};
  const allowedKeys = new Set(["name", "description"]);
  const lines = match[1].split(/\r?\n/);
  lines.forEach((line, index) => {
    const separator = line.indexOf(":");
    const lineNumber = index + 2;
    if (separator <= 0) {
      issues.push(diagnostic("SKILL_FRONTMATTER_INVALID", "error", "frontmatter 行不是简单键值格式。", "使用 name: value 或 description: value。", { file: "SKILL.md", line: lineNumber }));
      return;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!allowedKeys.has(key) || key in value || !rawValue || /^[\[{&*!>|]/.test(rawValue)) {
      issues.push(diagnostic("SKILL_FRONTMATTER_INVALID", "error", "frontmatter 只允许非空、不重复的单行 name 和 description。", "删除额外或复杂字段。", { file: "SKILL.md", line: lineNumber }));
      return;
    }
    value[key] = rawValue.replace(/^(?:"([\s\S]*)"|\x27([\s\S]*)\x27)$/, "$1$2");
  });
  for (const key of allowedKeys) {
    if (!(key in value)) issues.push(diagnostic("SKILL_FRONTMATTER_INVALID", "error", "frontmatter 缺少 " + key + "。", "补充必需字段。", { file: "SKILL.md", line: 1 }));
  }
  return { value, body: source.slice(match[0].length), issues };
}

function checkSkillMarkdown(source) {
  const parsed = parseFrontmatter(source);
  const issues = [...parsed.issues];
  const requiredSections = [
    [/^# (?:目标|Goal)\s*$/mi, "目标"],
    [/^# (?:必需输入|Required input)\s*$/mi, "必需输入"],
    [/^# (?:专家编排|Workflow|Orchestration)\s*$/mi, "专家编排"],
    [/^# (?:完成与失败|Failure handling|Completion and failure)\s*$/mi, "完成与失败"]
  ];
  for (const [pattern, label] of requiredSections) {
    if (!pattern.test(parsed.body)) issues.push(diagnostic("SKILL_REQUIRED_SECTION_MISSING", "error", "SKILL.md 缺少必需章节：" + label + "。", "按编排型 Skill 契约补充该章节。", { file: "SKILL.md" }));
  }
  const placeholderPattern = /replace-with-|\bTODO\b|\bTBD\b|待定/g;
  let match;
  while ((match = placeholderPattern.exec(source))) {
    issues.push(diagnostic("SKILL_PLACEHOLDER_REMAINS", "error", "SKILL.md 仍包含未完成占位标记。", "替换为当前 Skill 的真实内容。", { file: "SKILL.md", line: lineForOffset(source, match.index) }));
  }
  if (parsed.value?.name) {
    const nameCharacters = characterCount(parsed.value.name);
    if (nameCharacters < skillNameMinCharacters || nameCharacters > skillNameMaxCharacters) {
      issues.push(diagnostic(
        "SKILL_NAME_LENGTH_INVALID",
        "error",
        `name 长度不合规（当前 ${nameCharacters} 字符，要求 ${skillNameMinCharacters}-${skillNameMaxCharacters} 字符）。`,
        "将 name 调整为 2-64 个字符，并保持与目录名一致。",
        { file: "SKILL.md", line: 2 }
      ));
    }
  }
  if (parsed.value?.description) {
    const description = parsed.value.description;
    const descriptionCharacters = characterCount(description);
    if (descriptionCharacters > descriptionMaxCharacters) {
      issues.push(diagnostic(
        "DESCRIPTION_LENGTH_EXCEEDED",
        "error",
        `description 长度超限（当前 ${descriptionCharacters} 字符，上限 ${descriptionMaxCharacters} 字符）。`,
        "精简 description，只保留用户可见产出和触发场景。",
        { file: "SKILL.md", line: 3 }
      ));
    }
    if (!descriptionTriggerPattern.test(description)) {
      issues.push(diagnostic("DESCRIPTION_TRIGGER_MISSING", "warning", "description 没有明确说明用户触发场景。", "补充用户实际会说的触发表达，同时保持 description 只承担索引作用。", { file: "SKILL.md", line: 3 }));
    }
    const head = description.split(/(?:当用户|用户(?:说|问|要|需要|希望|要求|提到)|when\b|use when\b)/iu)[0] ?? description;
    if (descriptionExecutionDetailPattern.test(head)) {
      issues.push(diagnostic("DESCRIPTION_EXECUTION_DETAIL", "warning", "description 的能力部分包含执行顺序、保存位置或否定规则。", "把执行细节移到正文，只保留独有产出和触发场景。", { file: "SKILL.md", line: 3 }));
    }
    if (descriptionImperativePattern.test(head)) {
      issues.push(diagnostic("DESCRIPTION_IMPERATIVE_STYLE", "warning", "description 像一条可直接执行的指令。", "改成陈述性名词短语，降低模型跳过正文直接委派的风险。", { file: "SKILL.md", line: 3 }));
    }
  }
  const bodyLines = lineCount(parsed.body);
  if (bodyLines > skillBodyRecommendedLines) {
    issues.push(diagnostic(
      "SKILL_BODY_LINES_RECOMMENDATION_EXCEEDED",
      "warning",
      `SKILL.md 正文 ${bodyLines} 行，超过建议的 ${skillBodyRecommendedLines} 行。`,
      "只保留核心流程，将确有渐进披露价值的细节拆到由 SKILL.md 直接链接的 references Markdown 文件。",
      { file: "SKILL.md" }
    ));
  }
  return { frontmatter: parsed.value, body: parsed.body, issues };
}

function directReferenceLinks(source) {
  const links = new Set();
  const pattern = /\]\((references\/[A-Za-z0-9._/-]+\.md)(?:#[^)\s]+)?\)/g;
  let match;
  while ((match = pattern.exec(source))) links.add(match[1]);
  return links;
}

function checkReferences(skillSource, sources) {
  const issues = [];
  const links = directReferenceLinks(skillSource);
  for (const packagePath of Object.keys(sources).filter((item) => item !== "SKILL.md")) {
    if (!links.has(packagePath)) {
      issues.push(diagnostic("RESOURCE_UNREFERENCED", "warning", "Markdown resource 没有被 SKILL.md 直接导航。", "从 SKILL.md 直接链接该资源并说明何时读取，或删除它。", { file: packagePath }));
    }
  }
  for (const linkedPath of links) {
    if (!sources[linkedPath]) {
      issues.push(diagnostic("RESOURCE_PATH_INVALID", "error", "SKILL.md 链接的 reference 不存在或不可读。", "修正链接或补充包内 Markdown 文件。", { file: "SKILL.md" }));
    }
  }
  return issues;
}

function stripMarkdownSuffix(value) {
  return value.trim().replace(/[`),.;，。；]+$/u, "");
}

function delegateCommandOnLine(line, start) {
  const openingBacktick = line.lastIndexOf("`", start);
  if (openingBacktick !== -1) {
    const closingBacktick = line.indexOf("`", start);
    if (closingBacktick !== -1) return line.slice(start, closingBacktick);
  }
  return stripMarkdownSuffix(line.slice(start));
}

function requiresDirectCliInvoke(line) {
  if (!/\bcli\.invoke\b/.test(line)) return false;
  return !/(?:不|不要|不得|禁止|避免)[^\n]{0,24}(?:直接)?(?:执行|调用|使用)?\s*`?cli\.invoke\b|(?:do not|don't|never|must not|without)[^\n]{0,24}\bcli\.invoke\b/i.test(line);
}

function checkDelegates(source) {
  const issues = [];
  const targets = [];
  const lines = source.split(/\r?\n/);
  let delegateCount = 0;
  lines.forEach((line, index) => {
    const start = line.indexOf("delegate --");
    if (start === -1) return;
    delegateCount += 1;
    const command = delegateCommandOnLine(line, start);
    const location = { file: "SKILL.md", line: index + 1 };
    if (/\$\(|`[^`]+`|\|\||&&|\s[|<>]\s/.test(command)) {
      issues.push(diagnostic("DELEGATE_FORMAT_INVALID", "error", "delegate 命令包含管道、重定向、命令替换或拼接。", "只保留单条标准 delegate 命令。", location));
      return;
    }
    const targetMatches = [...command.matchAll(/(?:^|\s)--target(?:\s+([^\s]+))?/g)];
    const instructionMatches = [...command.matchAll(/(?:^|\s)--instruction(?:\s+('(?:[^']|'"'"')*'|"[^"]*"|[^\s]+))?/g)];
    if (targetMatches.length !== 1 || instructionMatches.length !== 1 || /\s--(?!target\b|instruction\b)[a-z0-9-]+/i.test(command)) {
      issues.push(diagnostic("DELEGATE_FORMAT_INVALID", "error", "delegate 必须且只能包含一次 --target 和 --instruction。", "使用 delegate --target <agent-id> --instruction '<task>'。", location));
      return;
    }
    const target = stripMarkdownSuffix(targetMatches[0][1] ?? "");
    const rawInstruction = instructionMatches[0][1] ?? "";
    if (!target) {
      issues.push(diagnostic("DELEGATE_FORMAT_INVALID", "error", "delegate 缺少 target。", "提供已注册子专家 ID。", location));
    } else if (!allowedAgents.has(target)) {
      issues.push(diagnostic("DELEGATE_TARGET_UNKNOWN", "error", "delegate target 不是 full 主专家已注册子专家。", "改用六个公开目标之一。", location));
      issues.push(diagnostic("SECURITY_UNREGISTERED_AGENT", "error", "Skill 使用了未注册 Agent。", "删除或替换为公开子专家 target。", location));
    } else {
      targets.push({ target, line: index + 1 });
    }
    if (!rawInstruction || rawInstruction === "''" || rawInstruction === "\"\"") {
      issues.push(diagnostic("DELEGATE_INSTRUCTION_EMPTY", "error", "delegate instruction 缺失或为空。", "提供包含用户目标和约束的自包含任务。", location));
    }
    if (!/^'(?:[^']|'"'"')*'$/.test(rawInstruction)) {
      issues.push(diagnostic("DELEGATE_FORMAT_INVALID", "error", "delegate instruction 必须使用 Shell 单引号。", "使用 --instruction '<task>'，内部单引号用标准序列转义。", location));
    }
    if (hardcodedHomePattern.test(rawInstruction)) {
      issues.push(diagnostic("DELEGATE_HARDCODED_HOME_PATH", "warning", "delegate instruction 写死了具体用户的个人目录。", "让负责专家解析用户范围，或只传递上一步返回的真实业务路径。", location));
    }
    if (unresolvedDynamicValuePattern.test(rawInstruction)) {
      issues.push(diagnostic("DELEGATE_DYNAMIC_VALUE_UNRESOLVED", "warning", "delegate instruction 含未解析占位符或跨步骤指代。", "组装最终命令时替换为真实 delegation 结果；无法取得时停止依赖步骤。", location));
    }
  });

  if (delegateCount === 0) {
    issues.push(diagnostic("DELEGATION_WORKFLOW_STATIC_VALIDATION_INCOMPLETE", "warning", "正文中没有可机械识别的标准 delegate 命令。", "人工确认该 Skill 是否无需 NAS 专家；需要时补充标准 delegate 命令。", { file: "SKILL.md" }));
  }
  const missingStatuses = requiredStatusTokens.filter((token) => !source.includes(token));
  if (missingStatuses.length > 0) {
    issues.push(diagnostic("DELEGATION_RESULT_HANDLING_MISSING", "error", "正文没有覆盖全部 delegation 公开状态：" + missingStatuses.join(", ") + "。", "补充 completed、failed、cancelled、waiting_user、waiting_approval 的处理。", { file: "SKILL.md" }));
  }
  if (delegateCount > 1 && !/(真实|real)[^\n]{0,40}(结果|result)|上一步|upstream|下游|downstream/i.test(source)) {
    issues.push(diagnostic("DELEGATION_WORKFLOW_STATIC_VALIDATION_INCOMPLETE", "warning", "多委托正文缺少可机械识别的真实结果传递说明。", "人工确认下游只使用上游真实业务结果。", { file: "SKILL.md" }));
  }
  if (delegateCount > 0 && queryIntentPattern.test(source) && !emptyResultHandlingPattern.test(source)) {
    issues.push(diagnostic("EMPTY_RESULT_HANDLING_MISSING", "warning", "查询、筛选或批量流程没有明确空结果处理。", "说明无匹配时如实报告并停止，不切换相似数据源或擅自扩大范围。", { file: "SKILL.md" }));
  }
  return { issues, targets };
}

function checkCapabilityEvidence(source, cliAgents, delegateTargets) {
  const issues = [];
  const heading = source.match(/^# (?:生成期能力依据|Generation-time capability evidence)\s*$/mi);
  const evidence = [];
  if (heading) {
    const sectionStart = heading.index + heading[0].length;
    const rest = source.slice(sectionStart);
    const nextHeading = rest.search(/^#\s+/m);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    const pattern = /^\s*-\s+`([a-z][a-z0-9-]*)`\s+→\s+`([a-z][a-z0-9-]*)`\s*$/gm;
    let match;
    while ((match = pattern.exec(section))) {
      evidence.push({
        cli: match[1],
        agent: match[2],
        line: lineForOffset(source, sectionStart + match.index)
      });
    }
  }

  if (delegateTargets.length > 0 && evidence.length === 0) {
    issues.push(diagnostic(
      "CAPABILITY_EVIDENCE_MISSING",
      "error",
      "委托型 Skill 缺少可机械核对的生成期 CLI 唯一归属依据。",
      "添加“生成期能力依据”章节，并使用 - `<cli>` → `<agent>` 格式。",
      { file: "SKILL.md" }
    ));
    return issues;
  }

  const evidencedAgents = new Set();
  const seenClis = new Set();
  for (const item of evidence) {
    const location = { file: "SKILL.md", line: item.line };
    if (seenClis.has(item.cli)) {
      issues.push(diagnostic("CAPABILITY_EVIDENCE_DUPLICATE", "error", "生成期能力依据重复声明 CLI。", "每个 CLI 只保留一条唯一归属。", location));
      continue;
    }
    seenClis.add(item.cli);
    const expectedAgent = cliAgents.get(item.cli);
    if (!expectedAgent) {
      issues.push(diagnostic("CAPABILITY_EVIDENCE_CLI_UNKNOWN", "error", "生成期能力依据引用了 catalog 中不存在的 CLI。", "删除虚构 CLI 或改用 catalog 中的准确名称。", location));
      continue;
    }
    if (item.agent !== expectedAgent) {
      issues.push(diagnostic("CAPABILITY_EVIDENCE_AGENT_MISMATCH", "error", "CLI " + item.cli + " 的唯一子专家应为 " + expectedAgent + "。", "将映射和 delegate target 改为 catalog 声明的唯一 agent。", location));
      continue;
    }
    evidencedAgents.add(item.agent);
  }

  for (const item of delegateTargets) {
    if (!evidencedAgents.has(item.target)) {
      issues.push(diagnostic(
        "DELEGATE_TARGET_EVIDENCE_MISSING",
        "error",
        "delegate target 没有对应的 CLI 唯一归属依据。",
        "补充归属到该 target 的真实 CLI 依据，或修正 target。",
        { file: "SKILL.md", line: item.line }
      ));
    }
  }
  return issues;
}

function scanSecurity(fileName, source) {
  const issues = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const location = { file: fileName, line: index + 1 };
    if (runtimeFencePattern.test(line)) issues.push(diagnostic("SECURITY_SCRIPT_EXECUTION_UNSUPPORTED", "error", "Skill 包含不受支持的运行时脚本代码块。", "删除脚本，只保留 Markdown 编排说明。", location));
    if (privateKeyPattern.test(line) || credentialAssignmentPattern.test(line)) issues.push(diagnostic("SECURITY_CREDENTIAL_LITERAL", "error", "Skill 包含高置信度凭据字面量。", "删除凭据，运行时只从受控来源获取。", location));
    if (remoteDownloadPattern.test(line)) issues.push(diagnostic("SECURITY_REMOTE_DOWNLOAD", "error", "Skill 包含远端下载或下载后执行模式。", "删除远端下载和执行步骤。", location));
    if (requiresDirectCliInvoke(line)) issues.push(diagnostic("RUNTIME_DIRECT_CLI_INVOKE", "error", "full 主专家 Skill 要求父层直接执行 cli.invoke。", "改为委托负责该工作流的已注册子专家。", location));
    if (/\b(?:ug-ai|HERMES(?:\s+action)?|Host CLI|expert[-_ ]?id|correlation[-_ ]?id|request[-_ ]?id)\b/i.test(line)) issues.push(diagnostic("SECURITY_INTERNAL_CAPABILITY", "error", "Skill 引用了内部能力或关联标识。", "只使用公开 delegate target 和业务结果。", location));
    if (/\b(?:compact-main-agent|compact-unified-agent|compact profile)\b/i.test(line)) issues.push(diagnostic("RUNTIME_PROFILE_UNSUPPORTED", "error", "生成物声称支持当前未实证的 compact profile。", "只声明支持 kimage-planb full main-agent。", location));
    if (bypassPattern.test(line)) issues.push(diagnostic("SECURITY_GATEWAY_BYPASS", "error", "Skill 明确要求绕过审批、权限或审计。", "删除绕过指令并保留平台规则。", location));
    if (!line.includes("delegate --") && (directFileApiPattern.test(line) || httpCallPattern.test(line) || nasPathPattern.test(line))) issues.push(diagnostic("SECURITY_DIRECT_FILE_ACCESS", "error", "Skill 使用了 allowlist 外的文件、网络或 NAS 访问方式。", "通过已注册子专家完成真实 NAS 工作流。", location));
  });
  return issues;
}

export async function checkSkill(targetDirectory, options = {}) {
  const resolvedTarget = path.resolve(targetDirectory);
  const catalogContract = await loadCatalogContract(options.catalogPath ?? defaultCatalogPath);
  const targetRead = await readTarget(resolvedTarget, catalogContract.version);
  if (targetRead.earlyResult) return targetRead.earlyResult;

  const diagnostics = [...targetRead.diagnostics];
  const target = {};
  const skillSource = targetRead.sources["SKILL.md"];
  if (skillSource !== undefined) {
    const markdown = checkSkillMarkdown(skillSource);
    diagnostics.push(...markdown.issues);
    if (markdown.frontmatter?.name && skillNamePattern.test(markdown.frontmatter.name)) {
      target.skillName = markdown.frontmatter.name;
      if (markdown.frontmatter.name !== path.basename(resolvedTarget)) {
        diagnostics.push(diagnostic("SKILL_NAME_MISMATCH", "error", "目录名与 frontmatter name 不一致。", "把目录名和 name 统一为小写短横线名称。", { file: "SKILL.md", line: 2 }));
      }
    } else if (markdown.frontmatter?.name) {
      diagnostics.push(diagnostic("SKILL_NAME_INVALID", "error", "Skill 名称格式无效。", "使用小写字母、数字和单个短横线分段。", { file: "SKILL.md", line: 2 }));
    }
    diagnostics.push(...checkReferences(skillSource, targetRead.sources));
    const delegates = checkDelegates(skillSource);
    diagnostics.push(...delegates.issues);
    diagnostics.push(...checkCapabilityEvidence(skillSource, catalogContract.cliAgents, delegates.targets));
  }
  for (const [fileName, source] of Object.entries(targetRead.sources)) diagnostics.push(...scanSecurity(fileName, source));

  return finalizeResult({
    target,
    catalog: { checkedVersion: catalogContract.version },
    files: targetRead.files,
    diagnostics
  });
}
