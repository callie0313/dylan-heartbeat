const COMPANY = {
  name: "星果食品有限公司",
  english_name: "Starfruit Foods",
  products: ["杨桃果酱", "杨桃酒"],
  meal_service: {
    workdays_only: true,
    breakfast: "07:45-09:00",
    lunch: "11:30-14:00",
    included: ["基础餐食", "汤", "水", "咖啡", "茶"],
    free: true
  }
};

// 稳定世界事实；地点本身存在不等于 Shane 已经知道或会被注入上下文。
const FACILITIES = {
  CAFETERIA: {
    id: "CAFETERIA",
    label: "员工餐厅",
    purpose: "员工早餐、午餐使用的用餐区域"
  }
};

const EQUIPMENT = [
  ["A01", "清洗线", "A区"], ["A02", "分选输送线", "A区"], ["A03", "切分/破碎设备", "A区"],
  ["B01", "加热/浓缩设备", "B区｜果酱"], ["B02", "果酱灌装机", "B区｜果酱"], ["B03", "旋盖/贴标设备", "B区｜果酱"],
  ["C01", "原料处理/转运", "C区｜果酒"], ["C02", "发酵温控", "C区｜果酒"], ["C03", "过滤/转运", "C区｜果酒"], ["C04", "装瓶设备", "C区｜果酒"],
  ["D01", "压缩空气", "D区｜公用/包装"], ["D02", "冷却/温控辅助", "D区｜公用/包装"], ["D03", "包装输送线", "D区｜公用/包装"]
].map(([id, name, zone]) => ({ id, name, zone }));

const NPCS = [
  { id: "george_nelson", name: "George Nelson", age: 25, role: "设备维修技师", traits: ["外向", "健谈", "爱开玩笑", "维修能力不错"] },
  { id: "noah_holmes", name: "Noah Holmes", age: 26, role: "IT 技术员", traits: ["安静", "稳定", "理性", "工程思维"] },
  { id: "erin_walker", name: "Erin Walker", age: 38, role: "维修与设施主管", traits: ["决断稳定", "任务明确", "不做无意义微管理"] },
  { id: "miguel_santos", name: "Miguel Santos", age: 31, role: "设备维修技师", traits: ["随和", "务实", "擅长机械、泵和输送设备"] }
];

// 世界客观事实；不会复制进 Shane 的 known_npc_ids 或其他已知信息。
const WORLD_RELATIONSHIPS = [
  { people: ["george_nelson", "noah_holmes"], type: "partners" }
];

module.exports = { COMPANY, FACILITIES, EQUIPMENT, NPCS, WORLD_RELATIONSHIPS };
