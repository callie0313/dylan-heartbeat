const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { getDailyMenu, isWeekday } = require("../shane_work/canteen");

const DRINKS = ["水", "咖啡", "茶"];

test("同一工作日重复生成完全一致", () => {
  assert.deepEqual(getDailyMenu("2026-09-07"), getDailyMenu("2026-09-07"));
});

test("重新加载模块后同一工作日菜单仍一致", () => {
  const first = getDailyMenu("2026-09-08");
  delete require.cache[require.resolve("../shane_work/canteen")];
  const reloaded = require("../shane_work/canteen").getDailyMenu("2026-09-08");
  assert.deepEqual(reloaded, first);
});

test("不同工作日可产生不同菜单", () => {
  const menus = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"].map(getDailyMenu);
  assert.ok(new Set(menus.map(menu => JSON.stringify(menu))).size > 1);
});

test("早餐满足两种主食、蛋类、蛋白质、水果和常驻饮品", () => {
  const breakfast = getDailyMenu("2026-09-07").breakfast;
  assert.equal(breakfast.staples.length, 2);
  assert.equal(new Set(breakfast.staples).size, 2);
  assert.equal(breakfast.eggs.length, 1);
  assert.equal(breakfast.protein.length, 1);
  assert.equal(breakfast.fruit.length, 1);
  assert.deepEqual(breakfast.drinks, DRINKS);
});

test("午餐满足主食、两荤、两素、汤、水果或甜点和常驻饮品", () => {
  const lunch = getDailyMenu("2026-09-07").lunch;
  assert.equal(lunch.staples.length, 1);
  assert.equal(lunch.meat.length, 2);
  assert.equal(lunch.vegetables.length, 2);
  assert.equal(lunch.soup.length, 1);
  assert.equal(lunch.dessert_or_fruit.length, 1);
  assert.deepEqual(lunch.drinks, DRINKS);
});

test("两荤、两素不会重复", () => {
  for (const date of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]) {
    const lunch = getDailyMenu(date).lunch;
    assert.equal(new Set(lunch.meat).size, 2);
    assert.equal(new Set(lunch.vegetables).size, 2);
  }
});

test("周末没有员工早餐或午餐菜单", () => {
  assert.equal(isWeekday("2026-09-12"), false);
  assert.equal(getDailyMenu("2026-09-12"), null);
  assert.equal(getDailyMenu("2026-09-13"), null);
});

test("请假等个人状态不会影响工厂菜单", () => {
  assert.ok(getDailyMenu("2026-09-07"));
  assert.ok(getDailyMenu("2026-09-08"));
});

test("模块不包含模型、API 或角色进食事实", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "shane_work", "canteen.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|TARGET_API|wake_requests|Shane.*(?:吃|选择)|吃了什么/);
});
