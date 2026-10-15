// 填充地图的地理数据处理（纯函数，可单测）：
// GeoJSON 类型、区域名归一化与匹配、包围盒自适应投影、SVG 路径生成、数值色阶。

import type { MapRegion } from "@bi/types";

export type Position = [number, number];
export type Ring = Position[];
export type PolygonCoords = Ring[];
export type MultiPolygonCoords = Ring[][];

export interface GeoFeature {
  type: "Feature";
  properties: Record<string, unknown> & { name?: string };
  geometry:
    | { type: "Polygon"; coordinates: PolygonCoords }
    | { type: "MultiPolygon"; coordinates: MultiPolygonCoords };
}

export interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

/** 无可匹配数据时的填充色（与界面灰一致） */
export const MAP_NO_DATA_COLOR = "#e5e7eb";

/** 数值顺序色阶（浅蓝 → 深蓝，对齐 Power BI 默认主题蓝） */
export const MAP_COLOR_STOPS = ["#e8f1fb", "#9cc6f0", "#118dff", "#12239e"];

/** 中国行政区划后缀（按长度优先匹配，可重复剥离以处理「广西壮族自治区」） */
const CN_ADMIN_SUFFIXES = [
  "维吾尔自治区",
  "回族自治区",
  "壮族自治区",
  "特别行政区",
  "自治区",
  "自治州",
  "自治县",
  "省",
  "市",
  "地区",
  "盟",
  "县",
  "区",
];

/**
 * 归一化地区名：去空格/标点、忽略大小写、剥离中英文行政级别后缀。
 * 对数据值与 GeoJSON 名称使用同一函数，保证两侧一致。
 */
export function normalizeRegion(input: string): string {
  let s = (input ?? "").trim().toLowerCase();
  s = s.replace(/[\s.,'()_-]/g, "");
  s = s.replace(/^the/, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CN_ADMIN_SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, s.length - suffix.length);
        changed = true;
      }
    }
  }
  return s;
}

/** 常见国家/地区的中文名 → 世界地图英文名（键为中文名） */
const CN_COUNTRY_ALIAS: Record<string, string> = {
  中国: "China",
  美国: "United States of America",
  英国: "United Kingdom",
  法国: "France",
  德国: "Germany",
  意大利: "Italy",
  西班牙: "Spain",
  葡萄牙: "Portugal",
  荷兰: "Netherlands",
  比利时: "Belgium",
  瑞士: "Switzerland",
  奥地利: "Austria",
  瑞典: "Sweden",
  挪威: "Norway",
  丹麦: "Denmark",
  芬兰: "Finland",
  波兰: "Poland",
  希腊: "Greece",
  俄罗斯: "Russia",
  乌克兰: "Ukraine",
  土耳其: "Turkey",
  日本: "Japan",
  韩国: "South Korea",
  朝鲜: "North Korea",
  印度: "India",
  巴基斯坦: "Pakistan",
  孟加拉国: "Bangladesh",
  泰国: "Thailand",
  越南: "Vietnam",
  马来西亚: "Malaysia",
  印度尼西亚: "Indonesia",
  菲律宾: "Philippines",
  缅甸: "Myanmar",
  沙特阿拉伯: "Saudi Arabia",
  伊朗: "Iran",
  伊拉克: "Iraq",
  以色列: "Israel",
  埃及: "Egypt",
  南非: "South Africa",
  尼日利亚: "Nigeria",
  肯尼亚: "Kenya",
  埃塞俄比亚: "Ethiopia",
  摩洛哥: "Morocco",
  加拿大: "Canada",
  墨西哥: "Mexico",
  巴西: "Brazil",
  阿根廷: "Argentina",
  智利: "Chile",
  秘鲁: "Peru",
  哥伦比亚: "Colombia",
  澳大利亚: "Australia",
  新西兰: "New Zealand",
};

/**
 * 地级市/地区名 → 所属省级行政区短名（键值均为 normalizeRegion 后的形式）。
 * 当数据按城市聚合、而内置地图为省级边界时，用于将城市上卷到所在省份。
 * 直辖市（北京/天津/上海/重庆）与省名同形城市（吉林）无需登记，直接命中省级要素。
 */
const CITY_TO_PROVINCE: Record<string, string> = {
  // 河北
  石家庄: "河北", 唐山: "河北", 秦皇岛: "河北", 邯郸: "河北", 邢台: "河北", 保定: "河北",
  张家口: "河北", 承德: "河北", 沧州: "河北", 廊坊: "河北", 衡水: "河北",
  // 山西
  太原: "山西", 大同: "山西", 阳泉: "山西", 长治: "山西", 晋城: "山西", 朔州: "山西",
  晋中: "山西", 运城: "山西", 忻州: "山西", 临汾: "山西", 吕梁: "山西",
  // 内蒙古
  呼和浩特: "内蒙古", 包头: "内蒙古", 乌海: "内蒙古", 赤峰: "内蒙古", 通辽: "内蒙古",
  鄂尔多斯: "内蒙古", 呼伦贝尔: "内蒙古", 巴彦淖尔: "内蒙古", 乌兰察布: "内蒙古",
  兴安: "内蒙古", 锡林郭勒: "内蒙古", 阿拉善: "内蒙古",
  // 辽宁
  沈阳: "辽宁", 大连: "辽宁", 鞍山: "辽宁", 抚顺: "辽宁", 本溪: "辽宁", 丹东: "辽宁",
  锦州: "辽宁", 营口: "辽宁", 阜新: "辽宁", 辽阳: "辽宁", 盘锦: "辽宁", 铁岭: "辽宁",
  朝阳: "辽宁", 葫芦岛: "辽宁",
  // 吉林
  长春: "吉林", 四平: "吉林", 辽源: "吉林", 通化: "吉林", 白山: "吉林", 松原: "吉林",
  白城: "吉林", 延边: "吉林",
  // 黑龙江
  哈尔滨: "黑龙江", 齐齐哈尔: "黑龙江", 鸡西: "黑龙江", 鹤岗: "黑龙江", 双鸭山: "黑龙江",
  大庆: "黑龙江", 伊春: "黑龙江", 佳木斯: "黑龙江", 七台河: "黑龙江", 牡丹江: "黑龙江",
  黑河: "黑龙江", 绥化: "黑龙江", 大兴安岭: "黑龙江",
  // 江苏
  南京: "江苏", 无锡: "江苏", 徐州: "江苏", 常州: "江苏", 苏州: "江苏", 南通: "江苏",
  连云港: "江苏", 淮安: "江苏", 盐城: "江苏", 扬州: "江苏", 镇江: "江苏", 泰州: "江苏",
  宿迁: "江苏",
  // 浙江
  杭州: "浙江", 宁波: "浙江", 温州: "浙江", 嘉兴: "浙江", 湖州: "浙江", 绍兴: "浙江",
  金华: "浙江", 衢州: "浙江", 舟山: "浙江", 台州: "浙江", 丽水: "浙江",
  // 安徽
  合肥: "安徽", 芜湖: "安徽", 蚌埠: "安徽", 淮南: "安徽", 马鞍山: "安徽", 淮北: "安徽",
  铜陵: "安徽", 安庆: "安徽", 黄山: "安徽", 滁州: "安徽", 阜阳: "安徽", 宿州: "安徽",
  六安: "安徽", 亳州: "安徽", 池州: "安徽", 宣城: "安徽",
  // 福建
  福州: "福建", 厦门: "福建", 莆田: "福建", 三明: "福建", 泉州: "福建", 漳州: "福建",
  南平: "福建", 龙岩: "福建", 宁德: "福建",
  // 江西
  南昌: "江西", 景德镇: "江西", 萍乡: "江西", 九江: "江西", 新余: "江西", 鹰潭: "江西",
  赣州: "江西", 吉安: "江西", 宜春: "江西", 抚州: "江西", 上饶: "江西",
  // 山东
  济南: "山东", 青岛: "山东", 淄博: "山东", 枣庄: "山东", 东营: "山东", 烟台: "山东",
  潍坊: "山东", 济宁: "山东", 泰安: "山东", 威海: "山东", 日照: "山东", 临沂: "山东",
  德州: "山东", 聊城: "山东", 滨州: "山东", 菏泽: "山东",
  // 河南
  郑州: "河南", 开封: "河南", 洛阳: "河南", 平顶山: "河南", 安阳: "河南", 鹤壁: "河南",
  新乡: "河南", 焦作: "河南", 濮阳: "河南", 许昌: "河南", 漯河: "河南", 三门峡: "河南",
  南阳: "河南", 商丘: "河南", 信阳: "河南", 周口: "河南", 驻马店: "河南", 济源: "河南",
  // 湖北
  武汉: "湖北", 黄石: "湖北", 十堰: "湖北", 宜昌: "湖北", 襄阳: "湖北", 鄂州: "湖北",
  荆门: "湖北", 孝感: "湖北", 荆州: "湖北", 黄冈: "湖北", 咸宁: "湖北", 随州: "湖北",
  恩施: "湖北", 仙桃: "湖北", 潜江: "湖北", 天门: "湖北", 神农架: "湖北",
  // 湖南
  长沙: "湖南", 株洲: "湖南", 湘潭: "湖南", 衡阳: "湖南", 邵阳: "湖南", 岳阳: "湖南",
  常德: "湖南", 张家界: "湖南", 益阳: "湖南", 郴州: "湖南", 永州: "湖南", 怀化: "湖南",
  娄底: "湖南", 湘西: "湖南",
  // 广东
  广州: "广东", 韶关: "广东", 深圳: "广东", 珠海: "广东", 汕头: "广东", 佛山: "广东",
  江门: "广东", 湛江: "广东", 茂名: "广东", 肇庆: "广东", 惠州: "广东", 梅州: "广东",
  汕尾: "广东", 河源: "广东", 阳江: "广东", 清远: "广东", 东莞: "广东", 中山: "广东",
  潮州: "广东", 揭阳: "广东", 云浮: "广东",
  // 广西
  南宁: "广西", 柳州: "广西", 桂林: "广西", 梧州: "广西", 北海: "广西", 防城港: "广西",
  钦州: "广西", 贵港: "广西", 玉林: "广西", 百色: "广西", 贺州: "广西", 河池: "广西",
  来宾: "广西", 崇左: "广西",
  // 海南
  海口: "海南", 三亚: "海南", 三沙: "海南", 儋州: "海南",
  // 四川
  成都: "四川", 自贡: "四川", 攀枝花: "四川", 泸州: "四川", 德阳: "四川", 绵阳: "四川",
  广元: "四川", 遂宁: "四川", 内江: "四川", 乐山: "四川", 南充: "四川", 眉山: "四川",
  宜宾: "四川", 广安: "四川", 达州: "四川", 雅安: "四川", 巴中: "四川", 资阳: "四川",
  阿坝: "四川", 甘孜: "四川", 凉山: "四川",
  // 贵州
  贵阳: "贵州", 六盘水: "贵州", 遵义: "贵州", 安顺: "贵州", 毕节: "贵州", 铜仁: "贵州",
  黔西南: "贵州", 黔东南: "贵州", 黔南: "贵州",
  // 云南
  昆明: "云南", 曲靖: "云南", 玉溪: "云南", 保山: "云南", 昭通: "云南", 丽江: "云南",
  普洱: "云南", 临沧: "云南", 楚雄: "云南", 红河: "云南", 文山: "云南", 西双版纳: "云南",
  大理: "云南", 德宏: "云南", 怒江: "云南", 迪庆: "云南",
  // 西藏
  拉萨: "西藏", 日喀则: "西藏", 昌都: "西藏", 林芝: "西藏", 山南: "西藏", 那曲: "西藏",
  阿里: "西藏",
  // 陕西
  西安: "陕西", 铜川: "陕西", 宝鸡: "陕西", 咸阳: "陕西", 渭南: "陕西", 延安: "陕西",
  汉中: "陕西", 榆林: "陕西", 安康: "陕西", 商洛: "陕西",
  // 甘肃
  兰州: "甘肃", 嘉峪关: "甘肃", 金昌: "甘肃", 白银: "甘肃", 天水: "甘肃", 武威: "甘肃",
  张掖: "甘肃", 平凉: "甘肃", 酒泉: "甘肃", 庆阳: "甘肃", 定西: "甘肃", 陇南: "甘肃",
  临夏: "甘肃", 甘南: "甘肃",
  // 青海
  西宁: "青海", 海东: "青海", 海北: "青海", 黄南: "青海", 果洛: "青海", 玉树: "青海",
  海西: "青海",
  // 宁夏
  银川: "宁夏", 石嘴山: "宁夏", 吴忠: "宁夏", 固原: "宁夏", 中卫: "宁夏",
  // 新疆
  乌鲁木齐: "新疆", 克拉玛依: "新疆", 吐鲁番: "新疆", 哈密: "新疆", 昌吉: "新疆",
  博尔塔拉: "新疆", 巴音郭楞: "新疆", 阿克苏: "新疆", 克孜勒苏: "新疆", 喀什: "新疆",
  和田: "新疆", 伊犁: "新疆", 塔城: "新疆", 阿勒泰: "新疆", 石河子: "新疆",
  // 台湾
  台北: "台湾", 高雄: "台湾", 台中: "台湾", 台南: "台湾", 新北: "台湾", 桃园: "台湾",
  基隆: "台湾",
};

/** 由 GeoJSON 构造「归一化名称 → 要素下标」索引 */
export function buildRegionIndex(fc: GeoFeatureCollection): Map<string, number> {
  const index = new Map<string, number>();
  fc.features.forEach((f, i) => {
    const name = f.properties?.name;
    if (typeof name === "string") {
      const key = normalizeRegion(name);
      if (key && !index.has(key)) index.set(key, i);
    }
  });
  return index;
}

/** 将数据里的地区值匹配到要素下标；未命中返回 -1 */
export function matchRegion(
  value: string,
  index: Map<string, number>,
): number {
  const key = normalizeRegion(value);
  if (!key) return -1;
  const direct = index.get(key);
  if (direct !== undefined) return direct;
  const alias = CN_COUNTRY_ALIAS[key];
  if (alias) {
    const hit = index.get(normalizeRegion(alias));
    if (hit !== undefined) return hit;
  }
  // 城市上卷：数据为地级市、地图为省级边界时，映射到所属省份要素
  const province = CITY_TO_PROVINCE[key];
  if (province) {
    const hit = index.get(normalizeRegion(province));
    if (hit !== undefined) return hit;
  }
  return -1;
}

/** 数值范围；无有效值时返回 null */
export function extent(values: number[]): [number, number] | null {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  let min = nums[0];
  let max = nums[0];
  for (const v of nums) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

function interpolateStops(stops: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const segments = stops.length - 1;
  const scaled = clamped * segments;
  const i = Math.min(Math.floor(scaled), segments - 1);
  return mixHex(stops[i], stops[i + 1], scaled - i);
}

/**
 * 生成数值 → 颜色映射。缺失值/非数值返回 MAP_NO_DATA_COLOR；
 * 极值相同时统一取色阶末端色。
 */
export function makeColorScale(
  min: number,
  max: number,
  stops: string[] = MAP_COLOR_STOPS,
): (value: number | null | undefined) => string {
  return (value) => {
    if (value == null || !Number.isFinite(value)) return MAP_NO_DATA_COLOR;
    if (max === min) return stops[stops.length - 1];
    return interpolateStops(stops, (value - min) / (max - min));
  };
}

/** 墨卡托投影的 y 分量（纬度限制在 ±85° 避免极点发散）。
 *  返回值换算为「度」单位，与经度 x 量纲一致，避免纵横比失真。 */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 180) / Math.PI;
}

export interface FitProjection {
  width: number;
  height: number;
  project(lon: number, lat: number): Position;
}

/** 遍历要素集合中的所有坐标点 */
function forEachPosition(
  fc: GeoFeatureCollection,
  cb: (lon: number, lat: number) => void,
): void {
  for (const f of fc.features) {
    const rings =
      f.geometry.type === "Polygon"
        ? f.geometry.coordinates
        : f.geometry.coordinates.flat();
    for (const ring of rings) {
      for (const [lon, lat] of ring) cb(lon, lat);
    }
  }
}

/** 按要素包围盒生成自适应投影：墨卡托 + 居中缩放至 width×height */
export function createFitProjection(
  fc: GeoFeatureCollection,
  width: number,
  height: number,
  padding = 8,
): FitProjection {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  forEachPosition(fc, (lon, lat) => {
    const x = lon;
    const y = -mercatorY(lat);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const availW = Math.max(width - padding * 2, 1);
  const availH = Math.max(height - padding * 2, 1);
  const scale = Math.min(availW / spanX, availH / spanY);
  const offsetX = padding + (availW - spanX * scale) / 2;
  const offsetY = padding + (availH - spanY * scale) / 2;

  return {
    width,
    height,
    project(lon, lat) {
      const x = lon;
      const y = -mercatorY(lat);
      return [
        offsetX + (x - minX) * scale,
        offsetY + (y - minY) * scale,
      ] as Position;
    },
  };
}

function ringToPath(ring: Ring, proj: FitProjection): string {
  if (ring.length === 0) return "";
  const parts: string[] = [];
  ring.forEach(([lon, lat], i) => {
    const [x, y] = proj.project(lon, lat);
    parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  });
  return `${parts.join(" ")} Z`;
}

/** 将要素（Polygon / MultiPolygon）转为 SVG path 字符串 */
export function featureToPath(f: GeoFeature, proj: FitProjection): string {
  const rings =
    f.geometry.type === "Polygon"
      ? f.geometry.coordinates
      : f.geometry.coordinates.flat();
  return rings.map((ring) => ringToPath(ring, proj)).join(" ");
}

/** 按数据值在 china / world 两个索引上的匹配数自动识别地理范围 */
export function detectScope(
  values: string[],
  chinaIndex: Map<string, number>,
  worldIndex: Map<string, number>,
): "china" | "world" {
  let china = 0;
  let world = 0;
  for (const v of values) {
    if (matchRegion(v, chinaIndex) >= 0) china++;
    else if (matchRegion(v, worldIndex) >= 0) world++;
  }
  return china > world ? "china" : "world";
}

const geoCache = new Map<"china" | "world", Promise<GeoFeatureCollection>>();

/** 懒加载并缓存内置 GeoJSON 边界（独立 chunk，不进主包） */
export function loadGeo(region: "china" | "world"): Promise<GeoFeatureCollection> {
  const cached = geoCache.get(region);
  if (cached) return cached;
  const promise = (
    region === "china"
      ? import("@bi/assets/geo/china.json")
      : import("@bi/assets/geo/world.json")
  ).then((mod) => {
    const m = mod as unknown as { default?: GeoFeatureCollection };
    return (m.default ?? (mod as unknown as GeoFeatureCollection));
  });
  geoCache.set(region, promise);
  return promise;
}

/** 解析最终使用的地理范围：显式指定则直接返回，auto 时按数据识别 */
export async function resolveScope(
  region: MapRegion | undefined,
  values: string[],
): Promise<"china" | "world"> {
  if (region === "china" || region === "world") return region;
  const [china, world] = await Promise.all([loadGeo("china"), loadGeo("world")]);
  return detectScope(values, buildRegionIndex(china), buildRegionIndex(world));
}
