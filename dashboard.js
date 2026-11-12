"use strict";

const byId = id => document.getElementById(id);
const outcomes = ["Giữ CL", "Rớt 1 cấp", "Rớt 2 cấp", "Rớt khung ct", "Bỏ GIA", "Rớt size"];
const pages = {
  overview: ["Tổng quan", "", ""],
  pa1: ["PA1 · Hiện tại", "PA1 · Hiện tại", "Xác suất cuối, giá trị kỳ vọng và chi phí xử lý"],
  pa2: ["PA2 · Giải pháp mới", "PA2 · Giải pháp mới", "Xác suất cuối, giá trị kỳ vọng và chi phí xử lý"],
  quality: ["Kiểm tra dữ liệu", "Kiểm tra dữ liệu", "Kiểm tra giá cơ sở và tổng hệ số của hai phương án theo Batch"],
  admin: ["Admin", "Quản trị dữ liệu", "Cập nhật tỷ lệ theo Batch"]
};
const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("vi-VN", { style: "percent", maximumFractionDigits: 2 });
const factorPercent = new Intl.NumberFormat("vi-VN", { style: "percent", maximumFractionDigits: 8 });
const format = (value, style = number) => Number.isFinite(value) ? style.format(value) : "—";
const valid = Number.isFinite;
const sum = values => values.reduce((total, value) => total + value, 0);
const epsilon = 1e-8;
const pageSize = 50;
let records = [];
let allBaseValue = null;
let connected = false;
let page = "overview";
let offset = 0;
const projectOrigin = "https://cmhwjlnlfqhaorxzeaug.supabase.co";
const publicHeaders = { apikey: "sb_publishable_WqO79AU2WPMe3ASgXi-yRA_qnFu3us3" };
let loadingReport = false;
const exchange = 25840;
const bases = {
  price_wh: "Price WH", price_po: "Price PO", price_po_10: "Price PO 10%",
  price_avr: "Price Avr RAP", discounted: "Price Avr RAP (-5%)", price_best: "Price Best RAP"
};
const priceKeys = Object.keys(bases);
const inventoryPriceKeys = [...priceKeys, "keep_price"];
const moneyNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fixedMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const caratNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const expansion = new Map();
const planFilters = [...document.querySelectorAll("[data-plan-filter]")];
let po = "";
let currency = "VND";
let discount = -5;
let theme = "light";
let session = null;
let pendingRates = null;
let savingRates = false;
try { theme = localStorage.getItem("kcr-theme") === "dark" ? "dark" : "light"; } catch {}

function money(value, compact = false, unit = currency) {
  if (!valid(value)) return "—";
  const converted = value * (unit === "VND" ? exchange : 1);
  if (compact && unit === "USD") return format(value / 1e6, fixedMoney) + " triệu USD";
  if (compact && Math.abs(converted) >= 1e9) return format(converted / 1e9, moneyNumber) + " tỷ " + unit;
  if (compact && Math.abs(converted) >= 1e6) return format(converted / 1e6, moneyNumber) + " triệu " + unit;
  return format(converted, moneyNumber) + (compact ? " " + unit : "");
}

function gap(value, reference) {
  return valid(value) && valid(reference) && reference !== 0 ? value / reference - 1 : null;
}

function roundCents(value) {
  const cents = Math.abs(value) * 100;
  return Math.sign(value) * Math.round(cents + Math.max(1, cents) * Number.EPSILON) / 100;
}

function adjustmentLabel() {
  return (discount > 0 ? "+" : "") + discount + "%";
}

function enrich(row) {
  const multiplier = 1 + discount / 100;
  const discounted = valid(row.rap_avr) && valid(row.carat)
    ? roundCents(row.rap_avr * row.carat * multiplier) : null;
  const values = [row.value_factors, row.pa2_value_factors].map(factors => factors?.map((factor, i) =>
    valid(factor) && valid(row.prices_usd?.[i]) ? row.prices_usd[i] * factor * multiplier : null));
  const keep = row.prices_usd?.[0];
  return {
    ...row, discounted, keep_price: valid(keep) ? keep * multiplier : null, values
  };
}

function totals() {
  return {
    quantity: 0, carat: 0, rows: 0, price: Object.fromEntries(inventoryPriceKeys.map(key => [key, 0])),
    coverage: Object.fromEntries(inventoryPriceKeys.map(key => [key, 0])),
    plans: [0, 1].map(() => ({
      outcomes: Array(6).fill(0), counts: Array(6).fill(0), coverage: Array(6).fill(0),
      final: 0, complete: 0, rated: 0
    }))
  };
}

function addTotals(total, row) {
  total.rows++;
  total.quantity += row.quantity;
  total.carat += row.quantity * (row.carat ?? 0);
  for (const key of inventoryPriceKeys) {
    if (valid(row[key])) {
      total.price[key] += row.quantity * row[key];
      total.coverage[key]++;
    }
  }
  total.plans.forEach((plan, i) => {
    const probabilities = row.results[i].probabilities;
    probabilities?.forEach((rate, j) => { plan.counts[j] += row.quantity * rate; });
    if (probabilities) plan.rated++;
    const values = row.values[i];
    if (!values) return;
    values.forEach((value, j) => {
      if (valid(value)) {
        plan.outcomes[j] += value;
        plan.coverage[j]++;
      }
    });
    if (values.every(valid)) {
      plan.final += sum(values);
      plan.complete++;
    }
  });
}

function priceTotal(total, key) {
  return total.coverage[key] ? total.price[key] : null;
}

function finalTotal(plan) {
  return plan.complete ? plan.final : null;
}

const kpiPaths = {
  stock: "M3 7l9-4 9 4-9 4-9-4v10l9 4 9-4V7M12 11v10",
  warehouse: "M3 21V8l9-5 9 5v13H3m4 0V11h10v10M7 15h10m-10 3h10",
  purchase: "M6 3h9l4 4v14H6V3m8 0v5h5M9 12h7m-7 4h7",
  weight: "M5 8h14l2 13H3L5 8zm4 0V6a3 3 0 0 1 6 0v2",
  avr: "M3 8l4-5h10l4 5-9 13L3 8zm0 0h18M9 8l3 13 3-13",
  result: "M4 4v16h16M8 16v-4m4 4V9m4 7V6",
  delta: "M4 7h15m-4-4 4 4-4 4m5 6H5m4-4-4 4 4 4"
};

function kpiIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  const path = document.createElementNS(ns, "path");
  icon.setAttribute("class", "kpi-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", kpiPaths[name]);
  icon.append(path);
  return icon;
}

function renderCards(total, index = null) {
  const amount = key => priceTotal(total, key);
  const coverage = key => `${format(total.coverage[key], moneyNumber)}/${format(total.rows, moneyNumber)} Batch có giá`;
  const change = key => {
    const current = amount(key);
    const reference = amount("price_wh");
    return valid(current) && valid(reference)
      ? `So với WH: ${money(current - reference, true)} · ${format(gap(current, reference), percent)}` : "";
  };
  const result = (plan, i) => [
    "result", `Kết quả theo PA.${i}`, money(finalTotal(plan), true),
    connected ? `${format(plan.complete, moneyNumber)}/${format(total.rows, moneyNumber)} Batch đủ Final` : "",
    "", "accent"
  ];
  const difference = (plan, key, label, comparison) => {
    const value = finalTotal(plan);
    const reference = amount(key);
    const delta = valid(value) && valid(reference) ? value - reference : null;
    return ["delta", label, money(delta, true), `Final − ${comparison}`,
      format(gap(value, reference), percent), "accent", delta];
  };
  const stock = [
    ["stock", "Số lượng tồn kho", connected ? format(total.quantity, moneyNumber) : "—", "Viên"],
    ["warehouse", "Giá trị tồn kho WH", money(amount("price_wh"), true), connected ? coverage("price_wh") : ""],
    ["purchase", "Giá trị tồn kho theo PO", money(amount("price_po"), true), connected ? coverage("price_po") : "", change("price_po")]
  ];
  const weight = [
    ["weight", "Tổng trọng lượng", connected ? format(total.carat, caratNumber) : "—", "Carat"],
    ["avr", "Giá trị tồn kho theo Avr RAP", money(amount("price_avr"), true), connected ? coverage("price_avr") : "", change("price_avr")],
    ["avr", "Giá trị theo Chất lượng hiện tại", money(amount("keep_price"), true), connected ? coverage("keep_price") : "", change("keep_price")]
  ];
  const cards = index === null ? total.plans.flatMap((plan, i) => [
    ...(i === 0 ? stock : weight),
    result(plan, i + 1),
    difference(plan, "keep_price", `Tổn thất theo Phương án ${i + 1}`, "GT hiện tại"),
    difference(plan, "price_avr", `Chênh lệch KQ xử lý PA${i + 1} vs Avr RAP`, "Avr RAP"),
    difference(plan, "price_wh", `Chênh lệch KQ xử lý PA${i + 1} vs WH`, "WH")
  ]) : [
    ...stock, result(total.plans[index], index + 1),
    difference(total.plans[index], "price_wh", "Chênh lệch KQ xử lý vs WH", "WH"),
    ...weight,
    difference(total.plans[index], "keep_price", `Tổn thất theo Phương án ${index + 1}`, "GT hiện tại"),
    difference(total.plans[index], "price_avr", "Chênh lệch KQ xử lý vs Avr RAP", "Avr RAP")
  ];
  byId("cards").classList.toggle("plan-cards", index !== null);
  byId("cards").replaceChildren(...cards.map(item => {
    const [icon, label, value, hint, detail, style = "", delta] = item;
    const card = element("article", "", "card " + style);
    const tone = delta < 0 ? "loss" : delta > 0 ? "gain" : "";
    const heading = element("div", "", "kpi-label");
    heading.append(kpiIcon(icon), element("span", label));
    card.append(heading, element("strong", value, tone));
    if (hint) card.append(element("small", hint));
    if (detail && detail !== "—") card.append(element("small", detail, tone));
    return card;
  }));
}

function hierarchy(rows) {
  const root = { total: totals(), children: new Map() };
  for (const row of rows) {
    let node = root;
    addTotals(node.total, row);
    for (const value of [row.certificate || "Chưa có giấy", row.clarity || "Chưa có Clarity",
      format(row.size, moneyNumber)]) {
      if (!node.children.has(value)) node.children.set(value, { total: totals(), children: new Map() });
      node = node.children.get(value);
      addTotals(node.total, row);
    }
  }
  return root;
}

function renderPlan(rows, index) {
  const title = index === 0 ? "Phương án 1 · Hiện tại" : "Phương án 2 · Giải pháp mới";
  byId("plan-title").textContent = "Kết quả xử lý";
  const sign = discount < 0 ? "−" : "+";
  const calculation = `Giá cơ sở × Hệ số Giá trị 6 cấp × (100% ${sign} ${Math.abs(discount)}%)`;
  byId("plan-caption").replaceChildren(
    document.createTextNode(`${title} · ${calculation} · `),
    element("strong", "USD", "plan-usd")
  );
  const heads = [
    ["Giấy / Clarity", "/ Size"], ["SL"], ["Carat (ct)"], ["Price WH"], ["Price PO"], ["Price PO", "10%"],
    ["Price Avr RAP"], ["Price Avr RAP", `(${adjustmentLabel()})`], ["Giá trị", "hiện tại"],
    ...outcomes.map(name => [name]), ["Final"], ["So sánh", "GTHT"],
    ["So sánh Avr RAP", `(${adjustmentLabel()})`], ["So sánh", "WH"]
  ];
  const header = document.createElement("tr");
  for (const lines of heads) {
    const th = document.createElement("th");
    th.scope = "col";
    lines.forEach(line => th.append(element("span", line)));
    header.append(th);
  }
  byId("plan-head").replaceChildren(header);
  const tablePrices = ["price_wh", "price_po", "price_po_10", "price_avr", "discounted", "keep_price"];
  const root = hierarchy(rows);
  renderCards(root.total, index);
  const body = document.createDocumentFragment();
  const makeRow = (label, total, depth, node, key) => {
    const plan = total.plans[index];
    const value = finalTotal(plan);
    const changes = ["keep_price", "discounted", "price_wh"].map(ref => gap(value, priceTotal(total, ref)));
    const cells = [label, connected ? format(total.quantity, moneyNumber) : "—",
      connected ? format(total.carat, caratNumber) : "—", ...tablePrices.map(k => money(priceTotal(total, k), false, "USD")),
      ...plan.outcomes.map((v, j) => money(plan.coverage[j] ? v : null, false, "USD")), money(value, false, "USD"),
      ...changes.map(v => format(v, percent))];
    const tr = tableRow(cells, "td", 1);
    tr.cells[15].classList.add("final-cell");
    changes.forEach((v, j) => { if (v) tr.cells[16 + j].classList.add(v < 0 ? "loss" : "gain"); });
    if (depth === 0) tr.className = "group-row";
    if (node?.children.size) {
      const open = expansion.get(key) ?? depth === 0;
      const button = element("button", (open ? "▾ " : "▸ ") + label, "tree-button");
      button.type = "button";
      button.setAttribute("aria-expanded", String(open));
      button.addEventListener("click", () => {
        expansion.set(key, !open);
        renderPlan(rows, index);
        byId("plan-body").querySelectorAll(".tree-button").forEach(b => {
          if (b.dataset.tree === key) b.focus({ preventScroll: true });
        });
      });
      button.dataset.tree = key;
      tr.cells[0].replaceChildren(button);
    }
    if (depth > 0) tr.cells[0].style.paddingLeft = (6 + depth * 15) + "px";
    return tr;
  };
  const collator = new Intl.Collator("vi", {numeric:true});
  const addChildren = (node, depth, parents) => {
    const ordered = [...node.children].sort(([a], [b]) => collator.compare(a, b));
    for (const [label, child] of ordered) {
      const path = [...parents, label];
      const key = JSON.stringify(path);
      body.append(makeRow(label, child.total, depth, child, key));
      if (expansion.get(key) ?? depth === 0) addChildren(child, depth + 1, path);
    }
  };
  addChildren(root, 0, []);
  if (!rows.length) {
    const empty = tableRow([connected ? "Không có Batch phù hợp." : "Chưa có dữ liệu báo cáo."]);
    empty.cells[0].colSpan = heads.length;
    body.append(empty);
  }
  byId("plan-body").replaceChildren(body);
  byId("plan-foot").replaceChildren(makeRow("Tổng cộng", root.total, -1));
  byId("expand").disabled = !rows.length;
  byId("collapse").disabled = !rows.length;
}

function setTree(open) {
  expansion.clear();
  for (const row of records) {
    const certificate = row.certificate || "Chưa có giấy";
    expansion.set(JSON.stringify([certificate]), true);
    expansion.set(JSON.stringify([certificate, row.clarity || "Chưa có Clarity"]), open);
  }
  render();
}


function calculate(params, afterPolish) {
  const complete = values => Array.isArray(values) && values.length === 6 && values.every(valid);
  if (!complete(params) || !complete(afterPolish)) return {};
  const [a, b, c, d, e, l] = params;
  const keep = a * b + l;
  const seal = a * (1 - b) * c + (1 - a - l) * d * e;
  const polish = 1 - keep - seal;
  const probabilities = afterPolish.map((rate, index) => polish * rate + ([keep, seal][index] ?? 0));
  return { probabilities };
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function tableRow(cells, tag = "td", numericFrom = Infinity) {
  const row = document.createElement("tr");
  cells.forEach((value, index) => row.append(element(tag, value, index >= numericFrom ? "num" : "")));
  return row;
}

const chartColors = ["#248984", "#68b4ab", "#96acbc", "#c1a871", "#a194b6", "#809d88",
  "#74a5be", "#ab8f72", "#8ba49d", "#c591a0"];

function overviewGroups(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const label = row[field] || "Chưa phân loại";
    if (!groups.has(label)) groups.set(label, { label, quantity: 0, wh: 0, whRows: 0, final: [0, 0], finalRows: [0, 0] });
    const group = groups.get(label);
    group.quantity += row.quantity;
    if (valid(row.price_wh)) {
      group.wh += row.quantity * row.price_wh;
      group.whRows++;
    }
    row.values.forEach((values, i) => {
      if (values?.every(valid)) {
        group.final[i] += sum(values);
        group.finalRows[i]++;
      }
    });
  }
  return [...groups.values()].sort((a, b) => b.quantity - a.quantity);
}

function chartEmpty(target) {
  target.replaceChildren(element("p", connected ? "Không có dữ liệu." : "Chờ tải dữ liệu.", "chart-empty hint"));
}

function chartAmount(value, summary = false) {
  if (!valid(value)) return "—";
  return currency === "VND"
    ? format(value * exchange / 1e9, summary ? wholeNumber : fixedMoney)
    : format(value / 1e6, fixedMoney);
}

function summaryAmount(value) {
  const unit = currency === "VND" ? "tỷ VND" : "triệu USD";
  return valid(value) ? `${chartAmount(value, true)} ${unit}` : "—";
}

function drawPlanBars(target, plans) {
  const values = plans.map(finalTotal);
  if (!values.some(valid)) return chartEmpty(target);
  const height = Math.max(...values.filter(valid).map(Math.abs), 1);
  const bars = element("div", "", "plan-chart-bars");
  values.forEach((value, index) => {
    const column = element("div", "", "plan-chart-column");
    const plot = element("div", "", "plan-chart-plot");
    const bar = element("div", "", "plan-chart-bar");
    const negative = valid(value) && value < 0;
    const half = values.some(v => valid(v) && v < 0);
    const baseline = half ? 50 : 100;
    const extent = valid(value) ? Math.abs(value) / height * (half ? 42 : 84) : 0;
    bar.style.height = extent + "%";
    bar.style.top = (negative ? baseline : baseline - extent) + "%";
    bar.style.background = chartColors[index];
    const axis = element("div", "", "plan-chart-axis");
    axis.style.top = baseline + "%";
    const number = element("span", valid(value) ? chartAmount(value) : "—", "plan-chart-number");
    number.style.top = (negative ? baseline + extent : baseline - extent) + "%";
    if (!negative) number.classList.add("above");
    plot.append(axis, bar, number);
    column.append(plot, element("strong", `PA.${index + 1}`));
    bars.append(column);
  });
  target.replaceChildren(bars);
}

function drawComposition(target, groups, total, label) {
  if (!total.quantity) return chartEmpty(target);
  let offset = 0;
  const segments = groups.map((group, i) => {
    const start = offset;
    offset += group.quantity / total.quantity * 100;
    return `${chartColors[i % chartColors.length]} ${start}% ${offset}%`;
  });
  const ring = element("div", "", "inventory-ring");
  ring.style.background = `conic-gradient(${segments.join(",")})`;
  ring.setAttribute("aria-hidden", "true");
  const center = element("div", "", "ring-center");
  center.append(element("strong", format(total.quantity, moneyNumber)), element("span", "viên tồn kho"));
  ring.append(center);
  const scroller = element("div", "", "chart-scroll");
  scroller.tabIndex = 0;
  scroller.setAttribute("aria-label", label);
  const table = document.createElement("table");
  table.className = "chart-legend";
  const header = table.createTHead();
  header.append(tableRow(["Nhóm", "Viên", "% WH"], "th", 1));
  const body = table.createTBody();
  for (const [i, group] of groups.entries()) {
    const share = group.whRows && total.price.price_wh ? group.wh / total.price.price_wh : null;
    const row = tableRow([group.label, format(group.quantity, moneyNumber), format(share, percent)], "td", 1);
    const dot = element("i", "", "swatch");
    dot.style.background = chartColors[i % chartColors.length];
    dot.setAttribute("aria-hidden", "true");
    row.cells[0].prepend(dot);
    body.append(row);
  }
  scroller.append(table);
  target.replaceChildren(ring, scroller);
}

function drawTreemap(target, groups, quantity) {
  const positive = groups.filter(group => group.quantity > 0);
  if (!quantity || !positive.length) return chartEmpty(target);
  const map = element("div", "", "inventory-treemap");
  map.setAttribute("aria-label", "Cơ cấu tồn theo Range, diện tích theo số viên");
  map.setAttribute("role", "group");
  const draw = (items, x, y, width, height) => {
    if (items.length === 1) {
      const group = items[0];
      const count = format(group.quantity, moneyNumber) + " viên";
      const share = format(group.quantity / quantity, percent);
      const cell = element("div", "", "treemap-cell");
      const tooltip = `${group.label} · ${count} · ${share}`;
      cell.title = tooltip;
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", tooltip);
      Object.assign(cell.style, {
        left: x / 3 + "%", top: y / 3 + "%", width: width / 3 + "%", height: height / 3 + "%",
        background: chartColors[positive.indexOf(group) % chartColors.length]
      });
      if (width >= 46 && height >= 30) cell.append(element("strong", group.label));
      if (width >= 62 && height >= 62) cell.append(element("span", count), element("span", share));
      map.append(cell);
      return;
    }
    const total = sum(items.map(group => group.quantity));
    let split = 1;
    let subtotal = items[0].quantity;
    while (split < items.length - 1 && subtotal + items[split].quantity / 2 < total / 2) {
      subtotal += items[split++].quantity;
    }
    const fraction = subtotal / total;
    if (width >= height) {
      const first = width * fraction;
      draw(items.slice(0, split), x, y, first, height);
      draw(items.slice(split), x + first, y, width - first, height);
    } else {
      const first = height * fraction;
      draw(items.slice(0, split), x, y, width, first);
      draw(items.slice(split), x, y + first, width, height - first);
    }
  };
  draw(positive, 0, 0, 300, 300);
  target.replaceChildren(map);
}

function drawHorizontal(target, entries, label) {
  if (!entries.some(entry => valid(entry.value))) return chartEmpty(target);
  const maximum = Math.max(...entries.map(entry => valid(entry.value) ? Math.abs(entry.value) : 0), 1);
  const list = element("div", "", "horizontal-chart chart-scroll");
  list.tabIndex = 0;
  list.setAttribute("aria-label", label);
  for (const { name, value, color } of entries) {
    const header = element("div", "", "horizontal-label");
    header.append(element("span", name), element("span", valid(value) ? chartAmount(value) : "—",
      value < 0 ? "loss" : ""));
    const track = element("div", "", "track");
    const bar = element("span", "", "fill");
    track.setAttribute("aria-hidden", "true");
    bar.style.width = valid(value) ? Math.abs(value) / maximum * 100 + "%" : "0%";
    bar.style.background = color || (value < 0 ? "var(--negative)" : "var(--positive)");
    track.append(bar);
    const row = element("div", "", "horizontal-row");
    row.append(header, track);
    list.append(row);
  }
  target.replaceChildren(list);
}

function renderOverviewCharts(total, rows) {
  const unit = currency === "VND" ? "tỷ VND" : "triệu USD";
  document.querySelectorAll("[data-chart-unit]").forEach(node => { node.textContent = unit; });
  document.querySelectorAll("[data-gap-unit]").forEach(node => { node.textContent = "Final − WH · " + unit; });
  const clarity = overviewGroups(rows, "clarity");
  const cert = overviewGroups(rows, "certificate");
  const range = overviewGroups(rows, "carat_range");
  const delta = group => ({
    name: group.label, values: group.final.map((value, i) => group.finalRows[i] && group.whRows ? value - group.wh : null)
  });
  drawPlanBars(byId("chart-plans"), total.plans);
  drawComposition(byId("chart-clarity"), clarity, total, "Cơ cấu theo Chất lượng");
  drawComposition(byId("chart-cert"), cert, total, "Cơ cấu theo Loại kiểm định");
  drawTreemap(byId("chart-range"), range, total.quantity);
  drawHorizontal(byId("chart-prices"), ["price_wh", "price_po", "price_avr", "price_best"].map((key, i) =>
    ({ name: bases[key], value: priceTotal(total, key), color: chartColors[i] })), "So sánh giá trị");
  drawPairs(byId("chart-clarity-gap"), clarity.map(delta), "Chênh lệch theo độ tinh khiết");
  drawPairs(byId("chart-range-gap"), [...range].sort((a, b) => (parseFloat(b.label) || 0) - (parseFloat(a.label) || 0))
    .map(delta), "Chênh lệch theo Range", chartAmount, false);
}

function drawPairs(target, entries, label, valueLabel = chartAmount, scroll = true) {
  const values = entries.flatMap(entry => entry.values).filter(valid);
  if (!values.length) return chartEmpty(target);
  const maximum = Math.max(...values.map(Math.abs), 1);
  const list = element("div", "", "paired-chart" + (scroll ? " chart-scroll" : ""));
  list.setAttribute("aria-label", label);
  if (scroll) list.tabIndex = 0;
  for (const entry of entries) {
    const row = element("div", "", "bar-group");
    const bars = document.createElement("div");
    row.append(element("span", entry.name), bars);
    entry.values.forEach((value, i) => {
      const line = element("div", "", "bar-line");
      const track = element("div", "", "track");
      const bar = element("span", "", "fill " + (i ? "two" : "one"));
      track.setAttribute("aria-hidden", "true");
      bar.style.width = valid(value) ? Math.abs(value) / maximum * 100 + "%" : "0%";
      track.append(bar);
      const text = valid(value) ? valueLabel(value) : "—";
      const number = element("span", text, value < 0 ? "loss" : "");
      number.setAttribute("aria-label", `PA${i + 1}: ${text}`);
      line.append(track, number);
      bars.append(line);
    });
    list.append(row);
  }
  target.replaceChildren(list);
}

function renderOverview(total, rows) {
  renderOverviewCharts(total, rows);
  const summaries = total.plans;
  drawPairs(byId("chart"), outcomes.map((name, i) => ({
    name, values: summaries.map(summary => summary.rated ? summary.counts[i] : null)
  })), "Số viên kỳ vọng theo kết quả", value => format(value, wholeNumber) + " viên", false);
  const comparison = byId("comparison");
  comparison.replaceChildren();
  const current = priceTotal(total, "keep_price");
  const finals = summaries.map(finalTotal);
  const losses = finals.map(value => valid(current) && valid(value) ? current - value : null);
  for (const [label, values] of [
    ["Giá cơ sở", [allBaseValue, allBaseValue]],
    ["Giá trị hiện tại", [current, current]],
    ["Giá trị kỳ vọng", finals],
    ["Tổn thất", losses]
  ]) {
    comparison.append(tableRow([label, ...values.map(summaryAmount)], "td", 1));
  }
  comparison.append(tableRow(["Tỷ lệ tổn thất", ...losses.map(loss =>
    format(valid(loss) && current !== 0 ? loss / current : null, percent))], "td", 1));
}

function renderDetails(rows) {
  const criteria = ["Thiếu Giá cơ sở", "Tổng hệ số PA1 khác 100%", "Tổng hệ số PA2 khác 100%"];
  const visible = [];
  const counts = [0, 0, 0];
  for (const row of rows) {
    if (row.quality.some(check => check.issue)) visible.push(row);
    row.quality.forEach((check, i) => { if (check.issue) counts[i]++; });
  }
  byId("quality-summary").replaceChildren(...criteria.map((label, i) => {
    const card = element("article", "", "quality-stat" + (counts[i] ? " has-issues" : ""));
    card.append(element("span", label), element("strong", connected ? format(counts[i], wholeNumber) : "—"),
      element("small", "Batch cần kiểm tra"));
    return card;
  }));
  const headers = ["Batch", "Nhóm tồn", "Giá cơ sở", "Tổng Hệ số Giá trị 6 cấp",
    "Tổng Hệ số Giá trị 6 cấp Phương án 2"];
  byId("detail-status").textContent = connected
    ? `${format(visible.length, wholeNumber)} / ${format(rows.length, wholeNumber)} Batch cần kiểm tra`
    : "Chưa có dữ liệu báo cáo.";
  const header = tableRow(headers, "th");
  for (const cell of header.cells) cell.scope = "col";
  byId("detail-head").replaceChildren(header);
  const body = byId("detail-body");
  body.replaceChildren();
  for (const row of visible.slice(offset, offset + pageSize)) {
    const tr = tableRow([row.batch, row.group_name]);
    for (const check of row.quality) {
      const cell = tr.insertCell();
      cell.append(element("span", check.issue ? "Kiểm tra" : "Đạt", check.issue ? "quality-badge warning" : "quality-badge"));
      cell.append(element("small", check.detail, "quality-cell-detail"));
    }
    body.append(tr);
  }
  if (!visible.length) {
    const row = tableRow([!connected ? "Đang chờ dữ liệu báo cáo." : rows.length
      ? "Không phát hiện lỗi trong ba điều kiện kiểm tra." : "Không có Batch phù hợp với bộ lọc."]);
    row.cells[0].colSpan = headers.length;
    row.cells[0].className = "quality-empty";
    body.append(row);
  }
  byId("prev").disabled = offset === 0;
  byId("next").disabled = offset + pageSize >= visible.length;
  byId("page-info").textContent = visible.length ? `${offset + 1}–${Math.min(offset + pageSize, visible.length)} / ${visible.length}` : "—";
}

function render() {
  const [name, title, subtitle] = pages[page];
  byId("page-name").textContent = name;
  byId("hero").hidden = page === "overview" || page === "pa1" || page === "pa2";
  byId("title").textContent = title;
  byId("subtitle").textContent = subtitle;
  for (const link of document.querySelectorAll("nav a")) {
    if (link.hash === "#" + page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  byId("admin").hidden = page !== "admin";
  byId("analysis").hidden = page === "admin";
  byId("overview").hidden = page !== "overview";
  byId("details").hidden = page !== "quality";
  byId("filters").hidden = page !== "quality";
  byId("plan").hidden = page !== "pa1" && page !== "pa2";
  const isPlan = !byId("plan").hidden;
  document.documentElement.dataset.page = page;
  document.documentElement.dataset.theme = theme;
  for (const [field, value] of [["po", po], ["currency", currency], ["theme", theme]]) {
    for (const button of document.querySelectorAll(`button[data-${field}]`)) {
      button.setAttribute("aria-pressed", String(button.dataset[field] === value));
    }
  }
  if (page === "admin") {
    renderAdmin();
    return;
  }
  const query = page === "overview" ? "" : byId(isPlan ? "plan-query" : "batch").value.trim().toUpperCase();
  const filters = isPlan ? planFilters.map(select => [select.dataset.planFilter, select.value])
    : page === "quality" ? [["group_name", byId("group").value], ["stock_status", byId("state").value]] : [];
  const active = filters.filter(([, value]) => value !== "");
  const rows = records.filter(row => (!po || row.po_type === po) && (!query || row.search.includes(query))
    && active.every(([field, value]) => String(row[field]) === value));
  if (page === "quality") {
    byId("cards").hidden = true;
    renderDetails(rows);
    return;
  }
  const valued = rows.map(enrich);
  if (page === "overview") {
    const total = totals();
    valued.forEach(row => addTotals(total, row));
    byId("cards").hidden = false;
    renderCards(total);
    renderOverview(total, valued);
  } else {
    byId("cards").hidden = false;
    renderPlan(valued, page === "pa1" ? 0 : 1);
  }
}

function checkFactorTotal(factors) {
  if (!factors?.every(valid)) return { issue: true, detail: "Thiếu hệ số" };
  const total = sum(factors);
  return { issue: Math.abs(total - 1) > epsilon, detail: format(total, factorPercent) };
}

function setRecords(rows, online) {
  connected = online;
  allBaseValue = null;
  for (const row of rows) {
    if (valid(row.prices_usd?.[0])) {
      allBaseValue = (allBaseValue ?? 0) + row.prices_usd[0] * row.quantity;
    }
  }
  records = rows.map(row => {
    const six = values => Array.isArray(values) && values.length === 6 ? values : null;
    const factors = six(row.value_factors);
    const pa2Factors = six(row.pa2_value_factors);
    const missing = outcomes.filter((_, i) => !valid(row.prices_usd?.[i]));
    return {
      ...row, value_factors: factors, pa2_value_factors: pa2Factors,
      quality: [{ issue: missing.length > 0, detail: missing.length ? `Thiếu: ${missing.join(", ")}` : "Đủ 6 giá" },
        checkFactorTotal(factors), checkFactorTotal(pa2Factors)],
      search: [row.batch, row.material, row.sloc].filter(Boolean).join(" ").toUpperCase(),
      results: [row.pa1_params, row.pa2_params].map(params =>
        calculate(params, row.after_polish))
    };
  });
  const controls = [[byId("group"), "group_name"], [byId("state"), "stock_status"],
    ...planFilters.map(select => [select, select.dataset.planFilter])];
  const collator = new Intl.Collator("vi", { numeric: true });
  for (const [select, field] of controls) {
    const selected = select.value;
    const options = [...new Set(records.map(row => row[field])
      .filter(value => value !== null && value !== undefined && String(value).trim() !== "").map(String))]
      .sort(collator.compare);
    select.replaceChildren(new Option("Tất cả", ""), ...options.map(value => new Option(value, value)));
    if (options.includes(selected)) select.value = selected;
  }
  offset = 0;
  render();
}

async function responseJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.error_description || error.msg || `HTTP ${response.status}`);
  }
  return response.json();
}

async function loadReport() {
  if (loadingReport) return;
  loadingReport = true;
  byId("status").textContent = "Đang tải báo cáo…";
  byId("report-error").hidden = true;
  byId("analysis").setAttribute("aria-busy", "true");
  try {
    const rows = [];
    let after = "";
    const columns = "batch,group_name,stock_status,quantity,pa1_params,pa2_params,after_polish,prices_usd,"
      + "po_type,material,sloc,certificate,clarity,size,carat,price_wh,price_po,price_po_10,price_avr,price_best,"
      + "rap_avr,purchase_source,carat_range,color,value_factors,pa2_value_factors";
    while (true) {
      const params = new URLSearchParams({ select: columns, order: "batch.asc", limit: "1000" });
      if (after) params.set("batch", "gt." + after);
      const chunk = await responseJson(projectOrigin + "/rest/v1/kcr_public_report?" + params, {
        headers: publicHeaders, signal: AbortSignal.timeout(20000)
      });
      if (!chunk.length) break;
      const next = chunk.at(-1).batch;
      if (typeof next !== "string" || next <= after) throw new Error("Batch không theo đúng thứ tự hoặc không duy nhất.");
      rows.push(...chunk);
      after = next;
    }
    setRecords(rows, true);
  } catch (error) {
    byId("report-error-message").textContent = "Không tải được dữ liệu báo cáo. " + error.message;
    byId("report-error").hidden = false;
  } finally {
    loadingReport = false;
    byId("analysis").removeAttribute("aria-busy");
    byId("status").textContent = "";
  }
}

byId("retry-report").addEventListener("click", loadReport);
byId("connect").addEventListener("submit", async event => {
  event.preventDefault();
  const feedback = byId("connection-feedback");
  byId("login").disabled = true;
  feedback.hidden = false;
  feedback.textContent = "Đang đăng nhập…";
  try {
    const { access_token: token } = await responseJson(projectOrigin + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { ...publicHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email: byId("email").value, password: byId("password").value })
    });
    const sessionHeaders = { ...publicHeaders, Authorization: "Bearer " + token };
    const admin = await responseJson(projectOrigin + "/rest/v1/rpc/kcr_is_admin", {
      method: "POST", headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body: "{}"
    });
    if (admin !== true) {
      feedback.textContent = "Tài khoản này chưa có quyền Admin.";
      return;
    }
    session = { headers: sessionHeaders };
    pendingRates = null;
    feedback.hidden = true;
    renderAdmin();
  } catch (error) {
    feedback.textContent = "Không đăng nhập được. " + error.message;
  } finally {
    byId("login").disabled = false;
    byId("password").value = "";
  }
});

byId("disconnect").addEventListener("click", () => {
  session = null;
  pendingRates = null;
  byId("rate-data").value = "";
  resetRatePreview();
  byId("admin-feedback").textContent = "";
  const feedback = byId("connection-feedback");
  feedback.hidden = false;
  feedback.textContent = "Đã đăng xuất Admin.";
  renderAdmin();
});
for (const button of document.querySelectorAll("button[data-po],button[data-currency],button[data-theme]")) {
  button.addEventListener("click", () => {
    if (button.dataset.po !== undefined) {
      po = button.dataset.po;
      offset = 0;
    }
    if (button.dataset.currency) currency = button.dataset.currency;
    if (button.dataset.theme) {
      theme = button.dataset.theme;
      try { localStorage.setItem("kcr-theme", theme); } catch {}
    }
    render();
  });
}
const discountInput = byId("discount");
function formatDiscountInput() {
  discountInput.value = adjustmentLabel();
  discountInput.removeAttribute("aria-invalid");
  byId("discount-error").hidden = true;
}

function stepDiscount(step) {
  const next = discount + step;
  if (!Number.isSafeInteger(next)) return;
  discount = next;
  formatDiscountInput();
  render();
}

byId("discount-down").addEventListener("click", () => stepDiscount(-1));
byId("discount-up").addEventListener("click", () => stepDiscount(1));
discountInput.addEventListener("keydown", event => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  stepDiscount(event.key === "ArrowUp" ? 1 : -1);
});
discountInput.addEventListener("input", () => {
  const match = /^([+-]?\d+)\s*%?$/.exec(discountInput.value.trim().replace("−", "-"));
  const value = match ? Number(match[1]) : NaN;
  const accepted = Number.isSafeInteger(value);
  discountInput.setAttribute("aria-invalid", String(!accepted));
  byId("discount-error").hidden = accepted || discountInput.value.trim() === "";
  if (accepted) {
    discount = value;
    render();
  }
});
discountInput.addEventListener("blur", formatDiscountInput);
byId("expand").addEventListener("click", () => setTree(true));
byId("collapse").addEventListener("click", () => setTree(false));
planFilters.forEach(select => select.addEventListener("change", render));
byId("plan-query").addEventListener("input", render);
byId("reset-plan-filters").addEventListener("click", () => {
  planFilters.forEach(select => { select.value = ""; });
  byId("plan-query").value = "";
  render();
});
for (const id of ["batch", "group", "state"]) byId(id).addEventListener("input", () => { offset = 0; render(); });
byId("prev").addEventListener("click", () => { offset -= pageSize; render(); });
byId("next").addEventListener("click", () => { offset += pageSize; render(); });

function renderAdmin() {
  byId("connect").hidden = Boolean(session);
  byId("disconnect").hidden = !session;
  byId("admin-updates").hidden = !session;
  byId("admin-form").hidden = !session;
  if (session && !byId("admin-feedback").textContent) {
    byId("admin-feedback").textContent = "Đã đăng nhập với quyền Admin.";
  }
}

function resetRatePreview() {
  pendingRates = null;
  byId("save-rates").disabled = true;
  const three = byId("rate-form").value === "three_steps";
  byId("rate-instructions").textContent = three
    ? "Dán Batch và 16 cột H:W của mẫu 3 bước thành một vùng liên tục."
    : "Dán Batch và 6 cột B:G của mẫu 6 TH rớt. Tổng mỗi dòng phải bằng 100%.";
}

function parseRates(value, form) {
  const width = form === "three_steps" ? 16 : 6;
  const known = new Set(records.map(row => row.batch));
  const seen = new Set();
  const lines = value.split(/\r?\n/).filter(line => line.trim());
  if (lines[0]?.split("\t")[0].trim().toLowerCase() === "batch") lines.shift();
  if (!lines.length) throw new Error("Hãy dán ít nhất một dòng dữ liệu.");
  return lines.map((line, index) => {
    const [batch, ...cells] = line.split("\t").map(cell => cell.trim());
    if (cells.length !== width || !known.has(batch) || seen.has(batch)) {
      throw new Error(`Dòng ${index + 1}: Batch chưa có, bị trùng hoặc sai số cột.`);
    }
    seen.add(batch);
    const rates = cells.map(cell => {
      const text = cell.replace(",", ".");
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(text)) return NaN;
      return text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
    });
    if (rates.some(rate => !valid(rate) || rate < 0 || rate > 1)
        || (form === "six_outcomes" && Math.abs(sum(rates) - 1) > 0.000001)) {
      throw new Error(`Dòng ${index + 1}: tỷ lệ trống, ngoài 0–100% hoặc sai tổng.`);
    }
    return { batch, rates };
  });
}

byId("rate-form").addEventListener("change", resetRatePreview);
byId("rate-data").addEventListener("input", resetRatePreview);
byId("preview-rates").addEventListener("click", () => {
  if (!session || savingRates) return;
  const feedback = byId("admin-feedback");
  resetRatePreview();
  try {
    if (!connected) throw new Error("Chờ báo cáo tải xong trước khi kiểm tra Batch.");
    const form = byId("rate-form").value;
    const items = parseRates(byId("rate-data").value, form);
    pendingRates = { form, items };
    feedback.textContent = `Đã kiểm tra ${format(items.length)} Batch. Batch đầu: ${items[0].batch}. Bấm Lưu để ghi lên Supabase.`;
    byId("save-rates").disabled = false;
  } catch (error) {
    feedback.textContent = error.message;
  }
});
byId("admin-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!session || !pendingRates || savingRates) return;
  savingRates = true;
  const feedback = byId("admin-feedback");
  const activeSession = session;
  const update = pendingRates;
  const fields = ["rate-form", "rate-data", "preview-rates", "save-rates"];
  fields.forEach(id => { byId(id).disabled = true; });
  feedback.textContent = "Đang lưu tỷ lệ…";
  try {
    const count = await responseJson(projectOrigin + "/rest/v1/rpc/kcr_update_rates", {
      method: "POST",
      headers: { ...activeSession.headers, "Content-Type": "application/json" },
      body: JSON.stringify(update)
    });
    if (activeSession === session) {
      byId("rate-data").value = "";
      resetRatePreview();
      feedback.textContent = `Đã lưu ${format(count)} Batch lên Supabase.`;
      if (update.form === "six_outcomes") loadReport();
    }
  } catch (error) {
    if (activeSession === session) feedback.textContent = "Chưa lưu dữ liệu. " + error.message;
  } finally {
    savingRates = false;
    fields.slice(0, -1).forEach(id => { byId(id).disabled = false; });
    byId("save-rates").disabled = !pendingRates;
  }
});
resetRatePreview();

function navigate() {
  const target = location.hash.slice(1);
  page = Object.hasOwn(pages, target) ? target : "overview";
  offset = 0;
  render();
}
window.addEventListener("hashchange", navigate);
document.querySelector(".skip-link").addEventListener("click", event => {
  event.preventDefault();
  byId("report-main").focus({ preventScroll: true });
});
const banner = document.querySelector(".top");
const sidebar = document.querySelector(".layout > aside");
function measureBanner() {
  document.documentElement.style.setProperty("--banner-height", banner.offsetHeight + "px");
  document.documentElement.style.setProperty("--sidebar-height", sidebar.offsetHeight + "px");
}
const navigationObserver = new ResizeObserver(measureBanner);
navigationObserver.observe(banner);
navigationObserver.observe(sidebar);
measureBanner();
navigate();
loadReport();


