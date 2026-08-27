#!/usr/bin/env node
/**
 * 032 预置文本机制 —— schema 校验脚本（Node 运行，无依赖）
 *
 * 用法：
 *   node packages/validate.mjs
 *
 * 校验范围：
 *   1. /packages 下所有 *.v{N}.json 包文件的 schema（含条目必须 {t, k?}，禁止 text/tags 残留）
 *   2. 条数上限（≤80）、id 唯一、version 与文件名一致
 *   3. manifest（index.json）字段合法性
 *   4. 重新生成 index.json 的 count / url 字段（自动统计，避免手改不一致）
 *
 * 任一项失败 → 非零退出码，CI 或本地手动跑均可用。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_ITEMS = 80;
const MAX_LEN = 40;       /* 中文条目上限：40 字 */
const MAX_LEN_EN = 80;    /* 英文条目上限：80 字符（英文按词计重，放宽一倍保持可读性） */

const errors = [];
const warn = [];

function err(msg) { errors.push(msg); console.error('  ✗ ' + msg); }
function warnMsg(msg) { warn.push(msg); console.warn('  ⚠ ' + msg); }

/* ---------- 读取所有包文件 ---------- */
const pkgFiles = readdirSync(HERE)
  .filter(f => /\.v\d+\.json$/.test(f))
  .sort();

if (!pkgFiles.length) {
  console.error('未找到任何 *.v{N}.json 包文件');
  process.exit(1);
}
console.log(`发现包文件 ${pkgFiles.length} 个：${pkgFiles.join(', ')}`);

const packages = [];
const seenIds = new Map();

for (const file of pkgFiles) {
  const m = file.match(/^(.+)\.v(\d+)\.json$/);
  const fileBase = m[1];
  const fileVer = Number(m[2]);
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
  } catch (e) {
    err(`${file}: JSON 解析失败 —— ${e.message}`);
    continue;
  }

  /* --- 顶层字段 --- */
  if (typeof raw.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw.id)) {
    err(`${file}: id 必须是小写英文+连字符（如 medical）`);
  }
  if (seenIds.has(raw.id)) {
    err(`${file}: id "${raw.id}" 与 ${seenIds.get(raw.id)} 重复`);
  } else if (typeof raw.id === 'string') {
    seenIds.set(raw.id, file);
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    err(`${file}: version 必须是正整数`);
  } else if (raw.version !== fileVer) {
    err(`${file}: 文件版本号 v${fileVer} 与内部 version=${raw.version} 不一致`);
  }
  if (typeof raw.name !== 'string' || !raw.name) err(`${file}: name 必填`);
  if (typeof raw.nameEn !== 'string' || !raw.nameEn) err(`${file}: nameEn 必填（英文包名）`);
  if (raw.lang !== undefined) warnMsg(`${file}: 双语包不再需要顶层 lang 字段（中英都在包内），可删除`);

  /* --- roles 只允许 deaf / vol --- */
  const roles = raw.roles || {};
  const badKeys = Object.keys(roles).filter(k => !['deaf', 'vol'].includes(k));
  if (badKeys.length) err(`${file}: roles 含非法键 ${badKeys.join(', ')}（只允许 deaf / vol）`);

  /* --- 条目校验（双语：t=中文必填 ≤40 字，en=英文必填 ≤80 字符） --- */
  let total = 0;
  for (const role of ['deaf', 'vol']) {
    const list = roles[role] || [];
    if (!Array.isArray(list)) { err(`${file}.roles.${role}: 必须是数组`); continue; }
    list.forEach((p, i) => {
      const where = `${file}.roles.${role}[${i}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) { err(`${where}: 必须是对象`); return; }
      if (typeof p.t !== 'string' || !p.t.trim()) { err(`${where}: t（中文）必填`); return; }
      if (p.t.trim().length > MAX_LEN) err(`${where}: t（中文）超长（${p.t.length} > ${MAX_LEN} 字）——「${p.t.slice(0, 20)}…」`);
      if (typeof p.en !== 'string' || !p.en.trim()) { err(`${where}: en（英文）必填，双语包条目必须中英齐全`); }
      else if (p.en.trim().length > MAX_LEN_EN) err(`${where}: en（英文）超长（${p.en.length} > ${MAX_LEN_EN} 字符）——「${p.en.slice(0, 30)}…」`);
      if (!['fill', 'send'].includes(p.k || 'fill')) err(`${where}: k 只允许 fill / send`);
      if (p.hasOwnProperty('text') || p.hasOwnProperty('tags')) {
        err(`${where}: 残留旧字段 text/tags，必须改回 {t, en, k?}`);
      }
      if (p.hasOwnProperty('_pkg') || p.hasOwnProperty('_ed')) {
        warnMsg(`${where}: 带 _pkg/_ed 字段（端内运行时标记，包文件里不应出现）`);
      }
      total++;
    });
  }
  if (total > MAX_ITEMS) err(`${file}: 条目 ${total} 条 > 上限 ${MAX_ITEMS}`);

  packages.push({ file, id: raw.id, version: raw.version, name: raw.name, count: total, raw });
}

/* ---------- manifest 校验 + 重新生成 count/url ---------- */
const manifestPath = join(HERE, 'index.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  err(`index.json: 读取/解析失败 —— ${e.message}`);
  manifest = { updatedAt: '', packages: [] };
}

const pkgById = new Map(packages.map(p => [p.id, p]));
const badManifestIds = [];
for (const item of manifest.packages || []) {
  if (!pkgById.has(item.id)) { badManifestIds.push(item.id); continue; }
  const p = pkgById.get(item.id);
  if (item.version !== p.version) {
    warnMsg(`manifest 中 ${item.id} 版本 ${item.version} 与包文件 v${p.version} 不一致 —— 将自动修正`);
  }
}

const rebuilt = {
  updatedAt: new Date().toISOString().slice(0, 10),
  packages: packages.map(p => {
    const prev = (manifest.packages || []).find(x => x.id === p.id) || {};
    return {
      id: p.id,
      name: prev.name || p.name,
      nameEn: prev.nameEn || (p.raw.nameEn || ''),
      desc: prev.desc || (p.raw.desc || ''),
      descEn: prev.descEn || (p.raw.descEn || ''),
      icon: prev.icon || (p.raw.icon || '📦'),
      version: p.version,
      count: p.count,
      url: `/packages/${p.file}`
    };
  })
};

if (badManifestIds.length) {
  err(`manifest 含不存在于磁盘的包：${badManifestIds.join(', ')}（请从 index.json 移除）`);
}

/* 没有致命错误才写回 manifest（count/url 自动生成部分） */
if (!errors.length) {
  writeFileSync(manifestPath, JSON.stringify(rebuilt, null, 2) + '\n', 'utf8');
  console.log('✅ 校验通过，index.json 已重新生成（count/url 自动统计）');
} else {
  console.error(`\n❌ 共 ${errors.length} 个错误，manifest 未写入。`);
  process.exit(1);
}