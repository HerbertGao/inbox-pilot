// CATEGORY_LABELS 全枚举映射单测（notification-mailbox-clarity 5.1）。
//
// `Record<Category, string>` 已在编译期（tsc --noEmit，验收 6.1）约束新增枚举臂必须配映射；
// 本测试是**运行期**双保险：遍历 ClassificationSchema 的权威 category 枚举臂，断言每一臂都有
// 非空中文映射、且映射值不等于英文枚举名（防直接渲染英文）。category 枚举源为 schema.ts。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClassificationSchema } from '../classifier/schema.js';
import { CATEGORY_LABELS } from './categoryLabels.js';

/** 从 ClassificationSchema 取出权威 category 枚举臂（运行期真相源）。 */
function schemaCategoryArms(): string[] {
  // ClassificationSchema 是 z.object；category 是 z.enum，options 暴露其枚举臂。
  const categorySchema = ClassificationSchema.shape.category;
  const options = categorySchema.options;
  assert.ok(Array.isArray(options) && options.length > 0, 'schema 暴露 category 枚举臂数组');
  return options as string[];
}

test('CATEGORY_LABELS：覆盖 ClassificationSchema 全部 category 枚举臂（运行期遍历断言）', () => {
  const arms = schemaCategoryArms();
  // 9 枚举臂（personal/work/finance/system_alert/security/newsletter/marketing/transaction/unknown）。
  assert.equal(arms.length, 9, 'category 枚举臂数（与 schema 同步、防漏配）');

  for (const arm of arms) {
    const label = (CATEGORY_LABELS as Record<string, string | undefined>)[arm];
    assert.ok(label !== undefined, `category 臂 ${arm} 必须有中文映射`);
    assert.equal(typeof label, 'string', `${arm} 映射为字符串`);
    assert.ok(label!.length > 0, `${arm} 中文映射非空`);
    // 禁止直接渲染英文枚举名：映射值不得等于英文枚举名本身。
    assert.notEqual(label, arm, `${arm} 映射不得是英文枚举名本身（须中文）`);
  }
});

test('CATEGORY_LABELS：无多余键（映射键集 == schema 枚举臂集，防漂移）', () => {
  const arms = new Set(schemaCategoryArms());
  for (const key of Object.keys(CATEGORY_LABELS)) {
    assert.ok(arms.has(key), `CATEGORY_LABELS 键 ${key} 必须是合法 category 枚举臂`);
  }
  assert.equal(Object.keys(CATEGORY_LABELS).length, arms.size, '映射键数 == 枚举臂数');
});
