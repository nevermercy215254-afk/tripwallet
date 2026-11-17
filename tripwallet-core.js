// ===== Trip Wallet — Core / Data layer v2 (Step 3) =====
// ไม่มี UI ในไฟล์นี้: เก็บข้อมูล ตรวจความถูกต้อง และคำนวณยอดทั้งหมด
// หน่วย: ยอดเยนเป็นจำนวนเต็มเสมอ / ยอดบาทเป็นทศนิยมได้ (ปัดตอนแสดงผล)
const TW = (() => {
  const KEY = 'tripwallet_v2';
  const KEY_BAK = 'tripwallet_v2_bak';
  const SCHEMA = 2;
  const MAX_PEOPLE = 5;
  const MAX_WALLETS = 4;
  const MAX_JPY = 10000000;
  const TAXFREE_MIN = 5000; // ขั้นต่ำขอคืนภาษี: ยอดก่อนภาษี ต่อใบเสร็จ
  const CATEGORIES = {
    food: 'อาหาร', shopping: 'ช้อปปิ้ง', transport: 'เดินทาง', ic: 'เติม Suica/IC',
    souvenir: 'ของฝาก', stay: 'ที่พัก', ticket: 'ตั๋ว/กิจกรรม', other: 'อื่นๆ', adjust: 'ปรับยอด'
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const nowIso = () => new Date().toISOString();
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fail = (msg) => { throw new Error(msg); };
  const cleanText = (s, max) => String(s == null ? '' : s).trim().slice(0, max || 100);
  // วันที่ตามเวลาเครื่อง (อยู่ญี่ปุ่น = เวลาญี่ปุ่น) รูปแบบ YYYY-MM-DD
  const localDate = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

  function emptyState() {
    const people = [];
    for (let i = 1; i <= MAX_PEOPLE; i++) people.push({ id: 'p' + i, name: 'คนที่ ' + i, active: i <= 2 });
    return {
      schema: SCHEMA,
      setupDone: false,
      trip: { name: 'ทริปญี่ปุ่น', start: '', end: '' },
      settings: { defaultRate: 0.23, lastWalletId: 'w1', lastOwners: ['p1'] },
      people,
      wallets: [
        { id: 'w1', name: 'YouTrip', kind: 'card', holderId: 'p1', lowPct: 20, active: true },
        { id: 'w2', name: 'เงินสด', kind: 'cash', holderId: 'p1', lowPct: 20, active: true }
      ],
      topups: [],   // {id, walletId, personId, jpy, rate, note, at}
      expenses: []  // {id, walletId, amount, owners[], category, note, store, at, updatedAt, tax|null}
      // tax = {rate, preTax|null, tax, manual, refund:{status:'pending'|'received'|'rejected', thb, receiverId, at}}
    };
  }

  // ---------- validation ----------
  function checkJpy(n, allowNegative) {
    if (!Number.isInteger(n)) fail('ยอดเงินต้องเป็นจำนวนเต็มเยน');
    if (n === 0) fail('ยอดเงินต้องไม่เป็น 0');
    if (!allowNegative && n < 0) fail('ยอดเงินต้องมากกว่า 0');
    if (Math.abs(n) > MAX_JPY) fail('ยอดเงินเกินขีดจำกัด');
  }
  function checkRate(r) {
    if (typeof r !== 'number' || !isFinite(r) || r <= 0 || r >= 10) fail('เรทไม่ถูกต้อง (ต้องอยู่ระหว่าง 0–10 บาท/เยน)');
  }
  function checkDate(d) { if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail('รูปแบบวันที่ไม่ถูกต้อง'); }
  function checkIso(t) { if (typeof t !== 'string' || isNaN(Date.parse(t))) fail('วันเวลาไม่ถูกต้อง'); return new Date(t).toISOString(); }
  const activePerson = (s, id) => s.people.find(p => p.id === id && p.active) || fail('ไม่พบผู้ใช้ที่เปิดใช้งาน: ' + id);
  const activeWallet = (s, id) => s.wallets.find(w => w.id === id && w.active) || fail('ไม่พบกระเป๋าเงิน: ' + id);
  function checkOwners(s, owners) {
    if (!Array.isArray(owners) || !owners.length) fail('ต้องเลือกเจ้าของรายการอย่างน้อย 1 คน');
    if (new Set(owners).size !== owners.length) fail('เลือกคนซ้ำ');
    owners.forEach(id => activePerson(s, id));
  }
  function checkCategory(c) { if (!(c in CATEGORIES)) fail('หมวดหมู่ไม่ถูกต้อง'); }

  // ภาษี: ถ้ามียอดก่อนภาษี → ภาษี = ยอดจ่าย − ยอดก่อนภาษี (ตรงตามใบเสร็จ)
  //       ถ้าไม่มี → ประมาณจากอัตรา / ถ้าผู้ใช้แก้ยอดภาษีเอง → ใช้ค่านั้น
  function calcTax(amount, t) {
    if (![8, 10].includes(t.rate)) fail('อัตราภาษีต้องเป็น 8% หรือ 10%');
    if (amount <= 0) fail('รายการขอคืนภาษีต้องมียอดจ่ายมากกว่า 0');
    let preTax = t.preTax == null || t.preTax === '' ? null : t.preTax;
    if (preTax !== null && (!Number.isInteger(preTax) || preTax <= 0 || preTax >= amount)) fail('ยอดก่อนภาษีต้องน้อยกว่ายอดที่จ่าย');
    let tax, manual = !!t.manual, estimated = false;
    if (manual) {
      tax = t.tax;
      if (!Number.isInteger(tax) || tax <= 0 || tax >= amount) fail('ยอดภาษีไม่ถูกต้อง');
    } else if (preTax !== null) {
      tax = amount - preTax;
    } else {
      tax = Math.round(amount * t.rate / (100 + t.rate));
      estimated = true;
    }
    const base = preTax !== null ? preTax : amount - tax;
    return { rate: t.rate, preTax, tax, manual, estimated, eligible: base >= TAXFREE_MIN };
  }

  function isValidState(s) {
    try {
      if (!s || s.schema !== SCHEMA || !Array.isArray(s.people) || s.people.length !== MAX_PEOPLE) return false;
      if (!Array.isArray(s.wallets) || !Array.isArray(s.topups) || !Array.isArray(s.expenses)) return false;
      s.wallets.forEach(w => { if (w.active) activePerson(s, w.holderId); });
      s.topups.forEach(t => { activeWallet(s, t.walletId); activePerson(s, t.personId); checkJpy(t.jpy, false); checkRate(t.rate); });
      s.expenses.forEach(e => {
        activeWallet(s, e.walletId); checkOwners(s, e.owners); checkCategory(e.category);
        checkJpy(e.amount, e.category === 'adjust');
        if (e.tax) calcTax(e.amount, e.tax);
      });
      return true;
    } catch (_) { return false; }
  }

  // ---------- calculations (pure) ----------
  // แบ่งเท่ากันแบบจำนวนเต็ม เศษไปที่คนแรกๆ ในรายชื่อ → ผลรวมเท่ายอดจริงเสมอ
  function splitInt(amount, owners) {
    const n = owners.length, base = Math.trunc(amount / n);
    let rem = amount - base * n;
    const out = {};
    owners.forEach(id => { const extra = rem > 0 ? 1 : rem < 0 ? -1 : 0; out[id] = base + extra; rem -= extra; });
    return out;
  }
  const shareOf = (e, pid) => (e.owners.includes(pid) ? splitInt(e.amount, e.owners)[pid] : 0);

  function refundThb(e) { return e.tax && e.tax.refund && e.tax.refund.status === 'received' ? e.tax.refund.thb : 0; }

  // ส่งยอดเคลียร์เป็นรายการโอนน้อยที่สุด (net > 0 = คนอื่นต้องโอนให้)
  function settleTransfers(nets) {
    const cred = [], debt = [];
    Object.keys(nets).forEach(id => { const v = Math.round(nets[id]); if (v > 0) cred.push({ id, v }); else if (v < 0) debt.push({ id, v: -v }); });
    cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
    const out = [];
    let i = 0, j = 0;
    while (i < cred.length && j < debt.length) {
      const x = Math.min(cred[i].v, debt[j].v);
      if (x > 0) out.push({ from: debt[j].id, to: cred[i].id, thb: x });
      cred[i].v -= x; debt[j].v -= x;
      if (cred[i].v === 0) i++;
      if (debt[j].v === 0) j++;
    }
    return out;
  }

  function summarize(s, now) {
    const today = localDate(now || Date.now());
    const people = s.people.filter(p => p.active);
    const wallets = s.wallets.filter(w => w.active);

    // ต่อกระเป๋า
    const W = {};
    wallets.forEach(w => { W[w.id] = { id: w.id, name: w.name, kind: w.kind, holderId: w.holderId, lowPct: w.lowPct, topupJpy: 0, topupThb: 0, spentJpy: 0 }; });
    s.topups.forEach(t => { W[t.walletId].topupJpy += t.jpy; W[t.walletId].topupThb += t.jpy * t.rate; });
    s.expenses.forEach(e => { W[e.walletId].spentJpy += e.amount; });
    Object.values(W).forEach(w => {
      w.avgRate = w.topupJpy ? w.topupThb / w.topupJpy : s.settings.defaultRate;
      w.balanceJpy = w.topupJpy - w.spentJpy;
      w.balanceThb = w.balanceJpy * w.avgRate;
      w.pctLeft = w.topupJpy ? (w.balanceJpy / w.topupJpy) * 100 : 0;
      w.low = w.topupJpy > 0 && w.pctLeft <= w.lowPct;
    });

    // ต่อคน (คิดเป็นบาท เพราะเคลียร์กันที่ไทย)
    const P = {};
    people.forEach(p => { P[p.id] = { id: p.id, name: p.name, contributedJpy: 0, contributedThb: 0, spentJpy: 0, spentThb: 0, heldThb: 0, refundCreditThb: 0, refundHeldThb: 0 }; });
    s.topups.forEach(t => { P[t.personId].contributedJpy += t.jpy; P[t.personId].contributedThb += t.jpy * t.rate; });
    s.expenses.forEach(e => {
      const sh = splitInt(e.amount, e.owners), rate = W[e.walletId].avgRate;
      Object.keys(sh).forEach(id => { P[id].spentJpy += sh[id]; P[id].spentThb += sh[id] * rate; });
      const r = refundThb(e);
      if (r) {
        e.owners.forEach(id => { P[id].refundCreditThb += r / e.owners.length; });
        P[e.tax.refund.receiverId].refundHeldThb += r;
      }
    });
    Object.values(W).forEach(w => { P[w.holderId].heldThb += w.balanceThb; });
    const nets = {};
    Object.values(P).forEach(p => {
      p.netThb = p.contributedThb - p.spentThb - p.heldThb + p.refundCreditThb - p.refundHeldThb;
      p.netSpentThb = p.spentThb - p.refundCreditThb; // ใช้จริงหลังหักเงินคืนภาษี
      nets[p.id] = p.netThb;
    });

    // ภาพรวม
    const totalTopupJpy = Object.values(W).reduce((a, w) => a + w.topupJpy, 0);
    const totalBalanceJpy = Object.values(W).reduce((a, w) => a + w.balanceJpy, 0);
    const totalBalanceThb = Object.values(W).reduce((a, w) => a + w.balanceThb, 0);
    const realExpenses = s.expenses.filter(e => e.category !== 'adjust');
    const totalSpentJpy = realExpenses.reduce((a, e) => a + e.amount, 0);

    const byCategory = {};
    realExpenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });

    // คืนภาษี
    const tax = { pendingCount: 0, pendingJpy: 0, receivedThb: 0, receivedCount: 0, rejectedCount: 0 };
    s.expenses.forEach(e => {
      if (!e.tax) return;
      const st = e.tax.refund.status;
      if (st === 'pending') { tax.pendingCount++; tax.pendingJpy += e.tax.tax; }
      else if (st === 'received') { tax.receivedCount++; tax.receivedThb += e.tax.refund.thb; }
      else tax.rejectedCount++;
    });

    // งบรายวัน (ถ้ากำหนดวันเดินทาง)
    let daily = null;
    if (s.trip.start && s.trip.end) {
      const totalDays = dayDiff(s.trip.start, s.trip.end) + 1;
      const dayNo = Math.min(Math.max(dayDiff(s.trip.start, today) + 1, 1), totalDays);
      const daysLeft = today > s.trip.end ? 0 : totalDays - dayNo + 1; // รวมวันนี้
      const todaySpent = realExpenses.filter(e => localDate(e.at) === today).reduce((a, e) => a + e.amount, 0);
      const spentBeforeToday = totalSpentJpy - todaySpent;
      daily = {
        totalDays, dayNo, daysLeft, todaySpent,
        avgPerDay: totalSpentJpy / Math.max(today < s.trip.start ? 1 : dayNo, 1),
        // งบที่ใช้ได้วันนี้ = (เงินเหลือ + ที่ใช้ไปแล้ววันนี้) / วันที่เหลือ
        allowToday: daysLeft ? Math.floor((totalBalanceJpy + todaySpent) / daysLeft) : 0,
        allowPerDayFromStart: totalTopupJpy / totalDays,
        spentBeforeToday
      };
    }

    return {
      today, wallets: W, people: P, totalTopupJpy, totalBalanceJpy, totalBalanceThb, totalSpentJpy,
      byCategory, tax, daily, transfers: settleTransfers(nets)
    };
  }

  // ---------- store ----------
  function createStore(storage) {
    let state = load();

    function load() {
      for (const k of [KEY, KEY_BAK]) {
        try {
          const raw = storage.getItem(k);
          if (!raw) continue;
          const s = JSON.parse(raw);
          if (isValidState(s)) return s;
        } catch (_) { /* ลองคีย์สำรองต่อ */ }
      }
      return emptyState();
    }

    // ทุกการแก้ไข: ทำบนสำเนา → ตรวจทั้งก้อน → บันทึก ถ้าพลาดจะ throw และ state เดิมไม่เปลี่ยน
    function commit(mutator) {
      const next = clone(state);
      const result = mutator(next);
      if (!isValidState(next)) fail('ข้อมูลไม่ถูกต้อง ไม่ได้บันทึก');
      const prevRaw = storage.getItem(KEY);
      storage.setItem(KEY, JSON.stringify(next));
      if (prevRaw) { try { storage.setItem(KEY_BAK, prevRaw); } catch (_) {} }
      state = next;
      return result;
    }
    const idx = (list, id) => { const i = list.findIndex(x => x.id === id); if (i < 0) fail('ไม่พบรายการ'); return i; };
    const inUse = (s, pid) => s.topups.some(t => t.personId === pid) || s.expenses.some(e => e.owners.includes(pid) || (e.tax && e.tax.refund.receiverId === pid)) || s.wallets.some(w => w.active && w.holderId === pid);

    function buildTax(s, amount, input, prev) {
      if (!input) return null;
      const t = calcTax(amount, input);
      const r = prev ? prev.refund : { status: 'pending', thb: 0, receiverId: s.wallets.find(w => w.kind === 'card' && w.active)?.holderId || 'p1', at: null };
      return { rate: t.rate, preTax: t.preTax, tax: t.tax, manual: t.manual, refund: r };
    }

    return {
      get: () => clone(state),
      summary: (now) => summarize(state, now),
      CATEGORIES,

      // --- คน ---
      setPerson(id, { name, active }) {
        return commit(s => {
          const p = s.people[idx(s.people, id)];
          if (name !== undefined) { p.name = cleanText(name, 20) || ('คนที่ ' + id.slice(1)); }
          if (active !== undefined) {
            if (!active && inUse(s, id)) fail(p.name + ' มีรายการอยู่ ปิดใช้งานไม่ได้');
            p.active = !!active;
          }
          const act = s.people.filter(x => x.active);
          if (!act.length) fail('ต้องมีอย่างน้อย 1 คน');
          if (new Set(act.map(x => x.name)).size !== act.length) fail('ชื่อซ้ำกัน');
          s.settings.lastOwners = s.settings.lastOwners.filter(o => act.some(x => x.id === o));
          if (!s.settings.lastOwners.length) s.settings.lastOwners = [act[0].id];
        });
      },

      // --- กระเป๋าเงิน ---
      setWallet(id, patch) {
        return commit(s => {
          const w = s.wallets[idx(s.wallets, id)];
          if ('name' in patch) w.name = cleanText(patch.name, 20) || w.name;
          if ('holderId' in patch) { activePerson(s, patch.holderId); w.holderId = patch.holderId; }
          if ('lowPct' in patch) { const v = Number(patch.lowPct); if (!(v >= 0 && v <= 100)) fail('เปอร์เซ็นต์แจ้งเตือนต้องเป็น 0–100'); w.lowPct = v; }
          if ('active' in patch) {
            if (!patch.active && (s.topups.some(t => t.walletId === id) || s.expenses.some(e => e.walletId === id))) fail('กระเป๋านี้มีรายการอยู่ ปิดใช้งานไม่ได้');
            w.active = !!patch.active;
            if (!s.wallets.some(x => x.active)) fail('ต้องมีอย่างน้อย 1 กระเป๋า');
          }
        });
      },
      addWallet({ name, kind, holderId }) {
        if (state.wallets.length >= MAX_WALLETS) fail('เพิ่มได้สูงสุด ' + MAX_WALLETS + ' กระเป๋า');
        const w = { id: 'w' + (state.wallets.length + 1), name: cleanText(name, 20) || 'กระเป๋าใหม่', kind: kind === 'card' ? 'card' : 'cash', holderId, lowPct: 20, active: true };
        commit(s => { activePerson(s, holderId); s.wallets.push(w); });
        return clone(w);
      },

      // --- ทริป ---
      setTrip({ name, start, end }) {
        return commit(s => {
          if (name !== undefined) s.trip.name = cleanText(name, 40) || 'ทริป';
          if (start !== undefined) { checkDate(start); s.trip.start = start || ''; }
          if (end !== undefined) { checkDate(end); s.trip.end = end || ''; }
          if (s.trip.start && s.trip.end && s.trip.end < s.trip.start) fail('วันกลับต้องไม่ก่อนวันไป');
        });
      },
      completeSetup() {
        if (!state.topups.length) fail('ต้องมียอดเติมเงินอย่างน้อย 1 รายการ');
        return commit(s => { s.setupDone = true; });
      },

      // --- เติมเงิน ---
      addTopup({ walletId, personId, jpy, rate, note }) {
        const t = { id: uid(), walletId, personId, jpy, rate, note: cleanText(note), at: nowIso() };
        commit(s => { checkJpy(jpy, false); checkRate(rate); s.topups.push(t); s.settings.defaultRate = rate; });
        return clone(t);
      },
      updateTopup(id, patch) {
        return commit(s => {
          const t = s.topups[idx(s.topups, id)];
          ['walletId', 'personId', 'jpy', 'rate'].forEach(k => { if (k in patch) t[k] = patch[k]; });
          if ('note' in patch) t.note = cleanText(patch.note);
        });
      },
      deleteTopup(id) { return commit(s => { s.topups.splice(idx(s.topups, id), 1); }); },

      // --- รายจ่าย ---
      // tax (ไม่บังคับ) = { rate: 10|8, preTax?, tax?, manual? }
      // at (ไม่บังคับ) = วันเวลาของรายการ ถ้าไม่ใส่ใช้เวลาปัจจุบัน
      addExpense({ walletId, amount, owners, category, note, store, tax, at }) {
        const t = at ? checkIso(at) : nowIso();
        const e = { id: uid(), walletId, amount, owners: (owners || []).slice(), category, note: cleanText(note), store: cleanText(store, 40), at: t, updatedAt: nowIso(), tax: null };
        commit(s => {
          activeWallet(s, walletId); checkOwners(s, e.owners); checkCategory(category);
          checkJpy(amount, category === 'adjust');
          if (tax && category === 'adjust') fail('รายการปรับยอดขอคืนภาษีไม่ได้');
          e.tax = buildTax(s, amount, tax, null);
          s.expenses.push(e);
          s.settings.lastWalletId = walletId; s.settings.lastOwners = e.owners.slice();
        });
        return clone(e);
      },
      updateExpense(id, patch) {
        return commit(s => {
          const e = s.expenses[idx(s.expenses, id)];
          ['walletId', 'amount', 'category'].forEach(k => { if (k in patch) e[k] = patch[k]; });
          if ('owners' in patch) e.owners = patch.owners.slice();
          if ('note' in patch) e.note = cleanText(patch.note);
          if ('store' in patch) e.store = cleanText(patch.store, 40);
          if ('at' in patch) e.at = checkIso(patch.at);
          if ('tax' in patch) e.tax = buildTax(s, e.amount, patch.tax, e.tax);
          else if (e.tax) e.tax = buildTax(s, e.amount, e.tax, e.tax); // ยอดเปลี่ยน → คำนวณภาษีใหม่
          e.updatedAt = nowIso();
        });
      },
      deleteExpense(id) { return commit(s => { s.expenses.splice(idx(s.expenses, id), 1); }); },

      // --- เงินคืนภาษี ---
      setRefund(expenseId, { status, thb, receiverId }) {
        return commit(s => {
          const e = s.expenses[idx(s.expenses, expenseId)];
          if (!e.tax) fail('รายการนี้ไม่ได้ขอคืนภาษี');
          if (!['pending', 'received', 'rejected'].includes(status)) fail('สถานะไม่ถูกต้อง');
          const r = e.tax.refund;
          if (status === 'received') {
            if (typeof thb !== 'number' || !isFinite(thb) || thb <= 0 || thb > 1000000) fail('ยอดเงินคืน (บาท) ไม่ถูกต้อง');
            activePerson(s, receiverId || r.receiverId);
            r.thb = Math.round(thb * 100) / 100; r.receiverId = receiverId || r.receiverId; r.at = nowIso();
          } else { r.thb = 0; r.at = status === 'rejected' ? nowIso() : null; }
          r.status = status;
        });
      },

      // --- ปรับยอดให้ตรงกับของจริง (นับเงินสด / ดูแอป YouTrip) ---
      reconcile(walletId, actualJpy, note) {
        if (!Number.isInteger(actualJpy) || actualJpy < 0) fail('ยอดจริงต้องเป็นจำนวนเต็มและไม่ติดลบ');
        const w = summarize(state).wallets[walletId] || fail('ไม่พบกระเป๋าเงิน');
        const diff = w.balanceJpy - actualJpy;
        if (diff === 0) return null;
        const owners = state.people.filter(p => p.active).map(p => p.id);
        return this.addExpense({ walletId, amount: diff, owners, category: 'adjust', note: note || 'ปรับยอดให้ตรงกับของจริง' });
      },

      listExpenses() { return clone(state.expenses).sort((a, b) => b.at.localeCompare(a.at)); },

      exportJson() { return JSON.stringify(state); },
      importJson(raw) {
        let s;
        try { s = JSON.parse(raw); } catch (_) { fail('ไฟล์สำรองอ่านไม่ได้'); }
        if (!isValidState(s)) fail('ไฟล์สำรองไม่ถูกต้องหรือเป็นเวอร์ชันอื่น');
        return commit(n => { Object.keys(n).forEach(k => delete n[k]); Object.assign(n, clone(s)); });
      },
      reset() { return commit(n => { Object.keys(n).forEach(k => delete n[k]); Object.assign(n, emptyState()); }); }
    };
  }

  return { createStore, summarize, splitInt, shareOf, calcTax, settleTransfers, CATEGORIES, TAXFREE_MIN, KEY, KEY_BAK };
})();

if (typeof module !== 'undefined') module.exports = TW;
