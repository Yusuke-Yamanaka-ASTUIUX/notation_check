let RULESET = null;

const $ = (id) => document.getElementById(id);

async function loadRules() {
  const status = $("status");
  try {
    // file:// 直開きでは fetch がCORSで失敗します（HTTP/HTTPS配信が必要）
    const url = new URL("rules.json", window.location.href);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`rules.json取得失敗: ${res.status} ${res.statusText} / ${url}`);
    }

    RULESET = await res.json();

    const name = RULESET?.meta?.name ?? "（名称未設定）";
    const version = RULESET?.meta?.version ?? "（版未設定）";
    $("metaLine").textContent = `ルールセット: ${name} / v${version}`;

    status.textContent = "✅ ルール読み込み完了";
  } catch (e) {
    console.error(e);
    $("metaLine").textContent = "ルール読込に失敗しました";
    status.textContent = "❌ rules.json 読み込み失敗: " + (e?.message ?? e);
  }
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[c]));
}

function escapeRegExp(s){
  return (s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

// 置換ルール用の「安全な」正規表現を生成
// 例：ng="お支払", ok="お支払い" → /お支払(?!い)/g
function buildSafeReplaceRegex(rule){
  const ng = rule?.ng;
  const ok = rule?.ok;

  // 明示的に ngRegex がある場合はそれを使う
  if (typeof rule?.ngRegex === "string" && rule.ngRegex.trim()){
    return new RegExp(rule.ngRegex, "g");
  }

  if (typeof ng !== "string" || typeof ok !== "string") return null;

  // OKがNGで始まる場合、既にOKの一部になっているNGは置換しない（重複防止）
  if (ok.startsWith(ng) && ok.length > ng.length){
    const suffix = ok.slice(ng.length);
    return new RegExp(`${escapeRegExp(ng)}(?!${escapeRegExp(suffix)})`, "g");
  }

  return null;
}

function matchPattern(rule, text) {
  return !!(rule?.pattern && text.includes(rule.pattern));
}

function matchRegex(rule, text) {
  if (!rule?.regex) return false;
  const re = new RegExp(rule.regex, "g");
  return re.test(text);
}

function matchReplace(rule, text){
  const re = buildSafeReplaceRegex(rule);
  if (re){
    return re.test(text);
  }
  return countOccurrences(text, rule.ng) > 0;
}

function countReplace(rule, text){
  const re = buildSafeReplaceRegex(rule);
  if (re){
    const m = text.match(re);
    return m ? m.length : 0;
  }
  return countOccurrences(text, rule.ng);
}

function applyReplace(rule, text){
  const re = buildSafeReplaceRegex(rule);
  if (re){
    return text.replace(re, rule.ok);
  }
  // 通常の文字列置換
  return text.split(rule.ng).join(rule.ok);
}

function ruleMatches(rule, text) {
  switch (rule?.type) {
    case "replace":
      return matchReplace(rule, text);
    case "pattern":
      return matchPattern(rule, text);
    case "regex":
      return matchRegex(rule, text);
    case "compound":
      if (Array.isArray(rule.ifAll) && rule.ifAll.length) {
        return rule.ifAll.every((cond) => ruleMatches(cond, text));
      }
      return false;
    default:
      return false;
  }
}

function runChecks(text) {
  const rules = RULESET?.rules;
  if (!Array.isArray(rules)) {
    return [{ severity: "warn", message: "ルールが読み込めていません。", id: "system" }];
  }

  const findings = [];

  for (const rule of rules) {
    if (!ruleMatches(rule, text)) continue;

    if (rule.type === "replace") {
      const n = countReplace(rule, text);
      if (n > 0){
        findings.push({
          id: rule.id || "(no-id)",
          severity: rule.severity || "error",
          ng: rule.ngRegex || rule.ng,
          ok: rule.ok,
          count: n,
          message: rule.message || `「${rule.ng}」は「${rule.ok}」に修正してください。`,
        });
      }
      continue;
    }

    if (rule.type === "pattern") {
      findings.push({
        id: rule.id || "(no-id)",
        severity: rule.severity || "warn",
        message: rule.message || `「${rule.pattern}」が含まれています（要確認）。`,
        pattern: rule.pattern,
      });
      continue;
    }

    if (rule.type === "regex") {
      findings.push({
        id: rule.id || "(no-id)",
        severity: rule.severity || "warn",
        message: rule.message || `正規表現ルールに一致しました: ${rule.regex}`,
        regex: rule.regex,
      });
      continue;
    }

    if (rule.type === "compound") {
      findings.push({
        id: rule.id || "(no-id)",
        severity: rule.severity || "warn",
        message: rule.message || "複合条件に一致しました。",
      });
      continue;
    }
  }

  return findings;
}

function applyReplacements(text) {
  const rules = RULESET?.rules;
  if (!Array.isArray(rules)) return { fixed: text, applied: [] };

  // 置換は「長いNGから順」にやると誤爆が減る
  const replaceRules = rules
    .filter(r => r?.type === "replace" && typeof r?.ok === "string")
    .slice()
    .sort((a,b) => (String(b.ng||"").length - String(a.ng||"").length));

  let fixed = text;
  const applied = [];

  for (const rule of replaceRules) {
    // ngRegexの場合もあるので、まずヒット数を数える
    const count = countReplace(rule, fixed);
    if (count <= 0) continue;

    fixed = applyReplace(rule, fixed);

    applied.push({
      id: rule.id || "(no-id)",
      ng: rule.ngRegex || rule.ng,
      ok: rule.ok,
      count,
    });
  }

  return { fixed, applied };
}

function renderFindings(findings) {
  const area = $("resultArea");

  if (findings.length === 0) {
    area.innerHTML = `<div class="result ok">✅ 表記ルール上の問題は見つかりませんでした。</div>`;
    return;
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity !== "error");

  const headerClass = errors.length ? "ng" : "warn";
  const headerText = errors.length
    ? `表記ルール違反の可能性があります（要修正 ${errors.length}件 / 要注意 ${warns.length}件）`
    : `要注意ポイントがあります（${warns.length}件）`;

  const cards = findings.map((f) => {
    const tagClass = f.severity === "error" ? "error" : "warn";
    const tagLabel = f.severity === "error" ? "要修正" : "要注意";

    const detailParts = [];
    if (f.ng) detailParts.push(`検出: <code>${escapeHtml(String(f.ng))}</code> × ${f.count ?? ""}`);
    if (f.ok) detailParts.push(`推奨: <code>${escapeHtml(String(f.ok))}</code>`);
    if (f.pattern) detailParts.push(`検出語: <code>${escapeHtml(String(f.pattern))}</code>`);
    if (f.regex) detailParts.push(`regex: <code>${escapeHtml(String(f.regex))}</code>`);

    return `
      <div class="card">
        <span class="tag ${tagClass}">${tagLabel}</span>
        <strong>${escapeHtml(f.message)}</strong><br>
        ${detailParts.length ? detailParts.join(" ／ ") : ""}
        <div class="muted">ruleId: ${escapeHtml(f.id)}</div>
      </div>
    `;
  }).join("");

  area.innerHTML = `
    <div class="result ${headerClass}">⚠ ${headerText}</div>
    ${cards}
  `;
}

function renderFixedText(text) {
  const out = $("fixedOutput");
  if (!out) return;
  out.value = text;
}

async function copyFixedText() {
  const out = $("fixedOutput");
  if (!out) return;

  const value = out.value || "";
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    $("status").textContent = "✅ 修正後文章をコピーしました";
  } catch (e) {
    out.focus();
    out.select();
    document.execCommand("copy");
    $("status").textContent = "✅ 修正後文章をコピーしました（フォールバック）";
  }
}

function onCheck() {
  const text = $("textInput").value || "";

  const findings = runChecks(text);
  renderFindings(findings.filter((f) => f.id !== "system" || text.length > 0));

  const { fixed, applied } = applyReplacements(text);
  renderFixedText(fixed);

  if (applied.length > 0) {
    const total = applied.reduce((sum, a) => sum + (a.count || 0), 0);
    $("status").textContent = `✅ 置換適用: ${applied.length}件（合計 ${total}箇所）`;
  }
}

function onClear() {
  $("textInput").value = "";
  $("resultArea").innerHTML = "";
  const out = $("fixedOutput");
  if (out) out.value = "";
  $("status").textContent = "";
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadRules();
  $("checkBtn")?.addEventListener("click", onCheck);
  $("clearBtn")?.addEventListener("click", onClear);
  $("copyBtn")?.addEventListener("click", copyFixedText);
});
