const { getDatePartsInTimeZone, resolveTimeZone } = require("../time_utils");

const TIME_ZONE = resolveTimeZone();
const DRINKS = ["水", "咖啡", "茶"];

const BREAKFAST = {
  staples: ["葱油饼", "全麦吐司", "豆沙包", "玉米", "燕麦粥", "小笼包", "烧麦", "可颂"],
  eggs: ["水煮蛋", "茶叶蛋", "番茄炒蛋", "煎蛋", "蛋羹"],
  protein: ["培根", "鸡肉肠", "酸奶", "芝士", "豆浆", "牛奶"],
  fruit: ["香蕉", "苹果", "橙子", "梨", "葡萄", "火龙果"]
};

const LUNCH = {
  staples: ["米饭", "杂粮饭", "番茄鸡蛋面", "炒河粉", "红薯", "馒头"],
  meat: ["宫保鸡丁", "红烧排骨", "黑椒牛柳", "清蒸鱼块", "香菇滑鸡", "土豆炖牛肉", "咖喱鸡块", "梅菜扣肉"],
  vegetables: ["蒜蓉西兰花", "清炒时蔬", "香菇青菜", "番茄炒茄子", "干煸四季豆", "清炒莲藕", "蚝油生菜", "木耳炒山药"],
  soup: ["玉米排骨汤", "番茄蛋花汤", "紫菜虾皮汤", "冬瓜薏米汤", "菌菇豆腐汤", "海带绿豆汤"],
  dessert_or_fruit: ["时令水果", "绿豆糕", "酸奶", "红豆小圆子", "银耳羹", "水果杯"]
};

function hashText(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function chooseDistinct(pool, count, seed) {
  const available = [...pool];
  const result = [];
  for (let index = 0; index < count && available.length; index += 1) {
    const selected = hashText(`${seed}:${index}`) % available.length;
    result.push(available.splice(selected, 1)[0]);
  }
  return result;
}

function dateKey(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = getDatePartsInTimeZone(value instanceof Date ? value : new Date(value), TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isWeekday(key) {
  const [year, month, day] = key.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

// 菜单是工厂当天客观供应，不描述任何人实际是否用餐或选择了什么。
function getDailyMenu(value = new Date()) {
  const date = dateKey(value);
  if (!isWeekday(date)) return null;

  return {
    date,
    breakfast: {
      staples: chooseDistinct(BREAKFAST.staples, 2, `${date}:breakfast:staples`),
      eggs: chooseDistinct(BREAKFAST.eggs, 1, `${date}:breakfast:eggs`),
      protein: chooseDistinct(BREAKFAST.protein, 1, `${date}:breakfast:protein`),
      fruit: chooseDistinct(BREAKFAST.fruit, 1, `${date}:breakfast:fruit`),
      drinks: [...DRINKS]
    },
    lunch: {
      staples: chooseDistinct(LUNCH.staples, 1, `${date}:lunch:staples`),
      meat: chooseDistinct(LUNCH.meat, 2, `${date}:lunch:meat`),
      vegetables: chooseDistinct(LUNCH.vegetables, 2, `${date}:lunch:vegetables`),
      soup: chooseDistinct(LUNCH.soup, 1, `${date}:lunch:soup`),
      dessert_or_fruit: chooseDistinct(LUNCH.dessert_or_fruit, 1, `${date}:lunch:dessert`),
      drinks: [...DRINKS]
    }
  };
}

module.exports = { getDailyMenu, dateKey, isWeekday };
