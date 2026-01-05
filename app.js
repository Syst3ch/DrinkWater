/* אורח חיים בריא – Food Tracker (Client-only)
   - Stores everything in localStorage.
   - Optional online calorie lookup (OpenFoodFacts) for packaged foods.
   - Photo feature: stores photo + user notes (no true CV inside browser).
*/

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORAGE_KEY = "hl_app_state_v1";

const todayISO = () => new Date().toISOString().slice(0,10);
const fmtDate = (iso) => {
  try{
    const [y,m,d] = iso.split("-").map(Number);
    return new Date(y, m-1, d).toLocaleDateString("he-IL", { weekday:"short", year:"numeric", month:"2-digit", day:"2-digit" });
  }catch{ return iso; }
};

function safeNum(v, fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round0(n){ return Math.round(n); }
function round1(n){ return Math.round(n*10)/10; }

function defaultState(){
  return {
    user: {
      name: "",
      profile: null, // {age, gender, heightCm, weightKg, activityFactor, tdee, kcalTarget, macroTargets, waterGoalMl}
      goalMode: "maintain", // maintain | cut | bulk (future)
      modes: { eatingOut:false },
      favorites: [], // saved meals templates
      weights: [] // [{dateISO, kg, ts}]
    },
    days: {
      // "YYYY-MM-DD": { foods: [...], waterMl: number, notes?: string, lastWaterTs?: number }
    },
    settings: {
      smartWater: { enabled:false, quietHours: { from:22, to:7 } },
      lookup: { openFoodFacts: true },
    }
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const st = JSON.parse(raw);
    return { ...defaultState(), ...st };
  }catch{
    return defaultState();
  }
}
function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ======= Health math ======= */
function calcBMR({age, gender, heightCm, weightKg}){
  // Mifflin-St Jeor
  // Men: 10W + 6.25H - 5A + 5
  // Women: 10W + 6.25H - 5A - 161
  const W = weightKg, H = heightCm, A = age;
  const base = 10*W + 6.25*H - 5*A;
  return base + (gender === "male" ? 5 : -161);
}
function calcTDEE(profile){
  const bmr = calcBMR(profile);
  return bmr * profile.activityFactor;
}
function defaultMacroTargets(kcalTarget, weightKg){
  // Simple reasonable defaults:
  // Protein: 1.6g/kg (maintain) ; Fat: 0.8g/kg ; Carbs: rest
  const proteinG = Math.max(80, Math.round(weightKg * 1.6));
  const fatG = Math.max(45, Math.round(weightKg * 0.8));
  const kcalFromPF = proteinG*4 + fatG*9;
  const carbsG = Math.max(50, Math.round((kcalTarget - kcalFromPF)/4));
  return { proteinG, carbsG, fatG };
}
function defaultWaterGoalMl(weightKg){
  return Math.round(weightKg * 35); // 35ml/kg
}

/* ======= Day utils ======= */
function ensureDay(iso){
  if(!state.days[iso]){
    state.days[iso] = { foods: [], waterMl: 0, lastWaterTs: 0, restDay: false };
  }
  return state.days[iso];
}
function getActiveDate(){
  return state.activeDate || todayISO();
}
function setActiveDate(iso){
  state.activeDate = iso;
  saveState();
  renderDashboard();
}

/* ======= UI: screens ======= */
function showScreen(id){
  ["#screenOnboarding","#screenProfile","#screenDashboard"].forEach(s=>{
    const el = $(s);
    el.hidden = (s !== id);
  });
}

function init(){
  // PWA
  registerSW();
  initInstallPrompt();

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#startBtn").addEventListener("click", startOnboarding);
  $("#backToOnboardingBtn").addEventListener("click", ()=>showScreen("#screenOnboarding"));
  $("#saveProfileBtn").addEventListener("click", saveProfile);

  $("#addFoodBtn").addEventListener("click", ()=>openAddFoodModal(getActiveDate()));
  $("#eatingOutBtn").addEventListener("click", toggleEatingOut);
  $("#restDayBtn").addEventListener("click", toggleRestDay);
  $("#weightBtn").addEventListener("click", openWeightModal);
  $("#favoritesBtn").addEventListener("click", openFavoritesModal);
  $("#historyBtn").addEventListener("click", openHistory);

  $("#macroTargetsBtn").addEventListener("click", openMacroTargets);
  $("#notifyBtn").addEventListener("click", toggleNotifications);

  $$("#screenDashboard [data-water]").forEach(btn=>{
    btn.addEventListener("click", ()=>addWater(parseInt(btn.dataset.water,10)));
  });
  $("#waterCustomBtn").addEventListener("click", openCustomWater);

  $("#exportBtn").addEventListener("click", exportData);
  $("#importBtn").addEventListener("click", ()=>$("#importFile").click());
  $("#importFile").addEventListener("change", importData);

  // Modal close
  $("#modalClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e)=>{ if(e.target.id==="modal") closeModal(); });
  document.addEventListener("keydown", (e)=>{ if(e.key==="Escape") closeModal(); });

  // Setup initial flow
  if(!state.user.name){
    showScreen("#screenOnboarding");
  } else if(!state.user.profile){
    showScreen("#screenProfile");
    $("#profileNamePill").textContent = state.user.name;
    $("#welcomeSub").textContent = "שלום " + state.user.name;
  } else {
    showScreen("#screenDashboard");
    $("#welcomeSub").textContent = "שלום " + state.user.name;
  }
  renderDashboard();
  tickSmartWater();
  setInterval(tickSmartWater, 60_000); // every minute
}

function startOnboarding(){
  const name = ($("#nameInput").value || "").trim();
  if(name.length < 2){
    toast("רשום שם קצר (לפחות 2 תווים).");
    return;
  }
  state.user.name = name;
  saveState();
  $("#profileNamePill").textContent = state.user.name;
  $("#welcomeSub").textContent = "שלום " + state.user.name;
  showScreen("#screenProfile");
}

function saveProfile(){
  const age = safeNum($("#ageInput").value);
  const gender = $("#genderInput").value;
  const heightCm = safeNum($("#heightInput").value);
  const weightKg = safeNum($("#weightInput").value);
  const activityFactor = safeNum($("#activityInput").value, 1.2);

  if(!age || !heightCm || !weightKg){
    toast("מלא גיל/גובה/משקל כדי לחשב יעד.");
    return;
  }

  let waterGoalL = safeNum($("#waterGoalInput").value, 0);
  let waterGoalMl = waterGoalL > 0 ? Math.round(waterGoalL*1000) : defaultWaterGoalMl(weightKg);

  const profile = { age, gender, heightCm, weightKg, activityFactor };
  const tdee = calcTDEE(profile);
  const kcalTarget = Math.round(tdee); // maintain

  const macroTargets = defaultMacroTargets(kcalTarget, weightKg);

  state.user.profile = { ...profile, tdee, kcalTarget, macroTargets, waterGoalMl };
  saveState();
  // close profile screen completely and go to dashboard
  showScreen("#screenDashboard");
  const profScreen = document.getElementById("screenProfile");
  if(profScreen) profScreen.hidden = true;

  // clear profile inputs so it never appears filled
  ["#ageInput","#heightInput","#weightInput","#waterGoalInput"].forEach(id=>{ const el=$(id); if(el) el.value=""; });

  renderDashboard();
  toast("נשמר! יעד יומי עודכן.");
}

/* ======= Render ======= */
function sumDay(iso){
  const day = ensureDay(iso);
  const foods = day.foods || [];
  const totals = foods.reduce((acc,f)=>{
    acc.kcal += safeNum(f.kcal);
    acc.protein += safeNum(f.protein);
    acc.carbs += safeNum(f.carbs);
    acc.fat += safeNum(f.fat);
    return acc;
  }, {kcal:0, protein:0, carbs:0, fat:0});
  return { ...totals, waterMl: safeNum(day.waterMl) };
}

function renderDashboard(){
  if(!state.user.profile){
    $("#screenDashboard").hidden = true;
    return;
  }

  showScreen("#screenDashboard");

  const iso = getActiveDate();
  const day = ensureDay(iso);
  $("#todayPill").textContent = fmtDate(iso) + (day.restDay ? " • יום חופשי" : "");

  // Update mode buttons
  const eatBtn = $("#eatingOutBtn");
  const restBtn = $("#restDayBtn");
  if(eatBtn) eatBtn.textContent = (eatingOut ? "✅ ארוחה בחוץ" : "🍽️ ארוחה בחוץ");
  if(restBtn) restBtn.textContent = (day.restDay ? "✅ יום חופשי" : "🛌 יום חופשי");

  const {kcalTarget, macroTargets, waterGoalMl} = state.user.profile;
  const eatingOut = !!state.user.modes?.eatingOut;
  const tol = eatingOut ? 0.15 : 0.0;
  $("#kcalLimit").textContent = round0(kcalTarget);

  const sums = sumDay(iso);
  $("#kcalEaten").textContent = round0(sums.kcal);

  // Calorie progress
  const pct = Math.min(200, (sums.kcal / Math.max(1,kcalTarget)) * 100);
  $("#kcalBar").style.width = pct + "%";
  if(tol>0){
    const low = Math.round(kcalTarget*(1-tol));
    const high = Math.round(kcalTarget*(1+tol));
    $("#kcalProgressText").textContent = `${round0(sums.kcal)} / ${round0(kcalTarget)} (טווח: ${low}–${high})`;
  } else {
    $("#kcalProgressText").textContent = `${round0(sums.kcal)} / ${round0(kcalTarget)} (${round0(Math.min(100,pct))}%)`;
  }

  // Macros
  const pPct = (sums.protein / Math.max(1, macroTargets.proteinG))*100;
  const cPct = (sums.carbs / Math.max(1, macroTargets.carbsG))*100;
  const fPct = (sums.fat / Math.max(1, macroTargets.fatG))*100;

  $("#proteinBar").style.width = Math.min(200,pPct) + "%";
  $("#carbBar").style.width = Math.min(200,cPct) + "%";
  $("#fatBar").style.width = Math.min(200,fPct) + "%";

  $("#proteinText").textContent = `${round0(sums.protein)} / ${macroTargets.proteinG}g`;
  $("#carbText").textContent = `${round0(sums.carbs)} / ${macroTargets.carbsG}g`;
  $("#fatText").textContent = `${round0(sums.fat)} / ${macroTargets.fatG}g`;

  // Water
  $("#waterDrank").textContent = round0(sums.waterMl);
  $("#waterGoal").textContent = round0(waterGoalMl);
  const wPct = (sums.waterMl / Math.max(1, waterGoalMl))*100;
  $("#waterBar").style.width = Math.min(200,wPct) + "%";
  $("#waterProgressText").textContent = `${round0(sums.waterMl)} / ${round0(waterGoalMl)} (${round0(Math.min(100,wPct))}%)`;

  renderFoodsList(iso);
  renderWeightCard();
  renderFavoritesPreview();
  renderSmartHint(iso);
}

function renderFoodsList(iso){
  const day = ensureDay(iso);
  const wrap = $("#todayFoods");
  wrap.innerHTML = "";

  if(!day.foods.length){
    wrap.innerHTML = `<div class="muted">עדיין לא הוספת אוכל להיום. לחץ על “הזנת אוכל”.</div>`;
    return;
  }

  day.foods
    .slice()
    .sort((a,b)=> (b.ts||0) - (a.ts||0))
    .forEach((f)=>{
      const item = document.createElement("div");
      item.className = "item";
      const grams = f.amountUnit === "g" ? `${f.amount}g` : (f.amountText || "");
      const macros = `P ${round0(f.protein||0)} • C ${round0(f.carbs||0)} • F ${round0(f.fat||0)}`;
      item.innerHTML = `
        <div>
          <div class="title">${escapeHtml(f.name || "פריט")}</div>
          <div class="sub">${escapeHtml(grams)} • ${escapeHtml(macros)}</div>
          ${f.photoDataUrl ? `<div class="sub">📷 מצורפת תמונה</div>` : ``}
        </div>
        <div class="right">
          <div class="kcal">${round0(f.kcal || 0)} kcal</div>
          <div class="actions">
            <button class="chip" data-action="view">צפייה</button>
            <button class="chip" data-action="fav">⭐ שמור</button>
            <button class="chip" data-action="del">מחק</button>
          </div>
        </div>
      `;
      item.querySelector('[data-action="fav"]').addEventListener("click", ()=>{
        saveFoodAsFavorite(f);
      });

      item.querySelector('[data-action="del"]').addEventListener("click", ()=>{
        if(confirm("למחוק את הפריט?")){
          day.foods = day.foods.filter(x=>x.id!==f.id);
          saveState();
          renderDashboard();
        }
      });
      item.querySelector('[data-action="view"]').addEventListener("click", ()=>openViewFoodModal(iso, f.id));
      wrap.appendChild(item);
    });
}

/* ======= Modals ======= */
function openModal(title, bodyNode, actions=[]){
  $("#modalTitle").textContent = title;
  const body = $("#modalBody");
  body.innerHTML = "";
  if(typeof bodyNode === "string"){
    body.innerHTML = bodyNode;
  } else {
    body.appendChild(bodyNode);
  }
  const act = $("#modalActions");
  act.innerHTML = "";
  actions.forEach(btn=>act.appendChild(btn));
  $("#modal").hidden = false;
}
function closeModal(){
  $("#modal").hidden = true;
}

function makeBtn(text, cls="ghost", onClick=null){
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  if(onClick) b.addEventListener("click", onClick);
  return b;
}

function openAddFoodModal(iso){
  const day = ensureDay(iso);

  const wrap = document.createElement("div");
  wrap.className = "grid";
  wrap.innerHTML = `
    <div class="grid two">
      <label class="field">
        <span>מה אכלת?</span>
        <input id="foodName" type="text" placeholder="לדוגמה: אורז מבושל">
      </label>
      <label class="field">
        <span>כמות</span>
        <div class="row gap">
          <input id="foodAmount" type="number" min="0" step="1" placeholder="לדוגמה: 200">
          <select id="foodUnit">
            <option value="g">גרם</option>
            <option value="custom">טקסט חופשי</option>
          </select>
        </div>
        <input id="foodAmountText" type="text" placeholder="לדוגמה: 5 כפות / 2 פיתות" style="margin-top:8px" hidden>
      </label>
    </div>

    <div class="grid two">
      <label class="field">
        <span>קלוריות</span>
        <input id="foodKcal" type="number" min="0" step="1" placeholder="אם ריק – ננסה להעריך">
        <small class="hint">אם השארת ריק: חיפוש בסיסי + הערכת קלוריות לפי 100 גרם (אם יש).</small>
      </label>
      <div class="card" style="padding:12px; box-shadow:none">
        <div class="muted small">מאקרו (אופציונלי)</div>
        <div class="grid two" style="margin-top:10px">
          <label class="field">
            <span>חלבון (גרם)</span>
            <input id="foodProtein" type="number" min="0" step="0.1" placeholder="0">
          </label>
          <label class="field">
            <span>פחמימה (גרם)</span>
            <input id="foodCarbs" type="number" min="0" step="0.1" placeholder="0">
          </label>
          <label class="field">
            <span>שומן (גרם)</span>
            <input id="foodFat" type="number" min="0" step="0.1" placeholder="0">
          </label>
          <label class="field">
            <span>סיבים (גרם)</span>
            <input id="foodFiber" type="number" min="0" step="0.1" placeholder="0">
          </label>
        </div>
      </div>
    </div>

    <div class="card note" style="padding:12px; box-shadow:none">
      <div class="row between">
        <div>
          <div style="font-weight:800">צילום מנה (אופציונלי)</div>
          <div class="muted small">האפליקציה תשמור את התמונה עם הפריט. זיהוי אוטומטי מלא דורש שירות חיצוני (API).</div>
        </div>
        <button class="chip" id="aiExplainBtn" title="הסבר על זיהוי תמונה">איך עושים זיהוי?</button>
      </div>
      <input id="foodPhoto" type="file" accept="image/*" capture="environment" style="margin-top:10px">
      <label class="field" style="margin-top:10px">
        <span>הערת מרכיבים (אם תרצה)</span>
        <textarea id="foodPhotoNotes" placeholder="לדוגמה: עוף, אורז, סלט…"></textarea>
      </label>
    </div>

    <div class="card" style="padding:12px; box-shadow:none">
      <div class="row between">
        <div>
          <div style="font-weight:800">הערכה אוטומטית לקלוריות</div>
          <div class="muted small">עובד הכי טוב כשממלאים גרמים + שם ברור.</div>
        </div>
        <button class="chip" id="estimateBtn">הערך עכשיו</button>
      </div>
      <div class="muted small" id="estimateStatus" style="margin-top:8px"></div>
    </div>
  `;

  // Hint about eating out mode
  if(state.user.modes?.eatingOut){
    const st = wrap.querySelector("#estimateStatus");
    if(st) st.textContent = "מצב ארוחה בחוץ פעיל: מותר לחרוג עד ~15% בלי לחץ.";
  }

  openModal("הזנת אוכל", wrap, [
    makeBtn("ביטול", "ghost", closeModal),
    makeBtn("שמור", "primary", async ()=>{
      const name = ($("#foodName").value || "").trim();
      if(!name){ toast("רשום מה אכלת."); return; }

      const unit = $("#foodUnit").value;
      let amount = safeNum($("#foodAmount").value, 0);
      let amountText = ($("#foodAmountText").value || "").trim();

      if(unit==="custom"){
        if(!amountText) amountText = "כמות לפי טקסט";
        amount = amount || 0;
      } else {
        if(!amount) { toast("מלא כמות בגרמים."); return; }
      }

      let kcal = safeNum($("#foodKcal").value, 0);
      let protein = safeNum($("#foodProtein").value, 0);
      let carbs = safeNum($("#foodCarbs").value, 0);
      let fat = safeNum($("#foodFat").value, 0);
      let fiber = safeNum($("#foodFiber").value, 0);

      // Auto estimate kcal if empty/0
      if(!kcal){
        const est = await estimateCalories({name, amount, unit, amountText});
        if(est?.kcal){
          kcal = est.kcal;
          // also fill macros if present and user left them blank
          if(!protein && est.protein) protein = est.protein;
          if(!carbs && est.carbs) carbs = est.carbs;
          if(!fat && est.fat) fat = est.fat;
        }
      }

      // Photo
      const photoFile = $("#foodPhoto").files?.[0];
      let photoDataUrl = "";
      if(photoFile){
        photoDataUrl = await fileToDataUrl(photoFile, 1024);
      }
      const photoNotes = ($("#foodPhotoNotes").value || "").trim();

      const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        name,
        amount,
        amountUnit: unit,
        amountText,
        kcal: Math.max(0, Math.round(kcal)),
        protein: Math.max(0, round1(protein)),
        carbs: Math.max(0, round1(carbs)),
        fat: Math.max(0, round1(fat)),
        fiber: Math.max(0, round1(fiber)),
        photoDataUrl,
        photoNotes,
        source: kcal ? "manual/estimated" : "manual"
      };
      day.foods.push(entry);
      saveState();
      closeModal();
      renderDashboard();
      toast("נוסף ליומן ✅");
    })
  ]);

  // unit toggle
  const unitSel = $("#foodUnit");
  const amountTextEl = $("#foodAmountText");
  unitSel.addEventListener("change", ()=>{
    const isCustom = unitSel.value === "custom";
    amountTextEl.hidden = !isCustom;
  });

  $("#estimateBtn").addEventListener("click", async ()=>{
    const name = ($("#foodName").value || "").trim();
    const unit = $("#foodUnit").value;
    const amount = safeNum($("#foodAmount").value, 0);
    const amountText = ($("#foodAmountText").value || "").trim();
    const status = $("#estimateStatus");
    status.textContent = "מחשב…";
    const est = await estimateCalories({name, amount, unit, amountText});
    if(est?.kcal){
      $("#foodKcal").value = est.kcal;
      status.textContent = `הערכה: ~${est.kcal} kcal (${est.source})`;
    } else {
      status.textContent = "לא הצלחתי להעריך. מלא קלוריות ידנית או נסה שם אחר.";
    }
  });

  $("#aiExplainBtn").addEventListener("click", ()=>{
    openModal("זיהוי תמונה – איך עובדים עם זה?", `
      <p class="muted">
        זיהוי מרכיבים וכמויות מתמונה בצורה אמינה דורש <b>שירות חיצוני</b> (API) של ראייה ממוחשבת.
        בגרסה הזו שמרנו פתרון פרקטי:
      </p>
      <ul class="bullets">
        <li>אפשר לצלם/להעלות תמונה למנה – והיא נשמרת עם הפריט.</li>
        <li>אפשר לרשום “הערת מרכיבים” (עוף/אורז/סלט וכו').</li>
        <li>אם תרצה – אפשר להוסיף בהמשך אינטגרציה ל־API (לדוגמה OpenAI Vision) עם מפתח שלך.</li>
      </ul>
      <p class="muted small">אם תרצה שאוסיף אינטגרציה אמיתית – תגיד באיזה שירות אתה רוצה להשתמש.</p>
    `, [makeBtn("סגור", "primary", closeModal)]);
  });
}

function openViewFoodModal(iso, id){
  const day = ensureDay(iso);
  const f = day.foods.find(x=>x.id===id);
  if(!f) return;

  const body = document.createElement("div");
  body.className = "grid";
  body.innerHTML = `
    <div class="row between">
      <div>
        <div style="font-weight:900; font-size:18px">${escapeHtml(f.name)}</div>
        <div class="muted small">${fmtDate(iso)} • ${escapeHtml(f.amountUnit==="g" ? (f.amount+"g") : (f.amountText||""))}</div>
      </div>
      <div style="font-weight:900">${round0(f.kcal)} kcal</div>
    </div>

    <div class="card" style="padding:12px; box-shadow:none">
      <div class="muted small">מאקרו</div>
      <div style="margin-top:10px; font-variant-numeric: tabular-nums">
        חלבון: <b>${round0(f.protein||0)}g</b> • פחמימה: <b>${round0(f.carbs||0)}g</b> • שומן: <b>${round0(f.fat||0)}g</b> • סיבים: <b>${round0(f.fiber||0)}g</b>
      </div>
    </div>

    ${f.photoDataUrl ? `
      <div class="card" style="padding:12px; box-shadow:none">
        <div class="muted small">תמונה</div>
        <img src="${f.photoDataUrl}" alt="תמונה" style="width:100%; border-radius:16px; margin-top:10px; border:1px solid rgba(255,255,255,.10)">
        ${f.photoNotes ? `<div class="muted small" style="margin-top:10px">📝 ${escapeHtml(f.photoNotes)}</div>` : ``}
      </div>
    ` : ``}
  `;

  openModal("פרטי פריט", body, [
    makeBtn("סגור", "primary", closeModal),
  ]);
}

function openHistory(){
  // List last 30 days with sums
  const dates = Object.keys(state.days).sort().reverse();
  const body = document.createElement("div");
  body.className = "grid";

  const top = document.createElement("div");
  top.className = "row gap wrap";
  top.innerHTML = `
    <button class="chip" id="goTodayBtn">היום</button>
    <button class="chip" id="pickDateBtn">בחירת תאריך…</button>
  `;
  body.appendChild(top);

  const list = document.createElement("div");
  list.className = "list";
  const slice = dates.slice(0, 60); // show last 60 saved days
  if(!slice.length){
    list.innerHTML = `<div class="muted">עדיין אין היסטוריה. תתחיל להוסיף אוכל.</div>`;
  } else {
    slice.forEach(iso=>{
      const s = sumDay(iso);
      const it = document.createElement("div");
      it.className = "item";
      it.innerHTML = `
        <div>
          <div class="title">${fmtDate(iso)}</div>
          <div class="sub">קלוריות: ${round0(s.kcal)} • P ${round0(s.protein)} • C ${round0(s.carbs)} • F ${round0(s.fat)}</div>
        </div>
        <div class="right">
          <button class="chip">פתח</button>
        </div>
      `;
      it.querySelector("button").addEventListener("click", ()=>{
        setActiveDate(iso);
        closeModal();
      });
      list.appendChild(it);
    });
  }
  body.appendChild(list);

  openModal("יומן / היסטוריה", body, [
    makeBtn("סגור", "primary", closeModal),
  ]);

  $("#goTodayBtn").addEventListener("click", ()=>{ setActiveDate(todayISO()); closeModal(); });
  $("#pickDateBtn").addEventListener("click", ()=>{
    const iso = prompt("הכנס תאריך בפורמט YYYY-MM-DD", getActiveDate());
    if(iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)){
      setActiveDate(iso);
      closeModal();
    } else if(iso) {
      toast("פורמט תאריך לא תקין.");
    }
  });
}

function openMacroTargets(){
  const prof = state.user.profile;
  const body = document.createElement("div");
  body.className = "grid";
  body.innerHTML = `
    <p class="muted">ערוך יעדי מאקרו יומיים (בגרמים). אפשר להשאיר לפי ברירת המחדל.</p>
    <div class="grid two">
      <label class="field">
        <span>חלבון (g)</span>
        <input id="tProtein" type="number" min="0" step="1" value="${prof.macroTargets.proteinG}">
      </label>
      <label class="field">
        <span>פחמימה (g)</span>
        <input id="tCarbs" type="number" min="0" step="1" value="${prof.macroTargets.carbsG}">
      </label>
      <label class="field">
        <span>שומן (g)</span>
        <input id="tFat" type="number" min="0" step="1" value="${prof.macroTargets.fatG}">
      </label>
    </div>
  `;
  openModal("יעדי מאקרו", body, [
    makeBtn("ביטול", "ghost", closeModal),
    makeBtn("שמור", "primary", ()=>{
      prof.macroTargets = {
        proteinG: Math.max(0, parseInt($("#tProtein").value,10)||0),
        carbsG: Math.max(0, parseInt($("#tCarbs").value,10)||0),
        fatG: Math.max(0, parseInt($("#tFat").value,10)||0),
      };
      saveState();
      closeModal();
      renderDashboard();
      toast("עודכן ✅");
    })
  ]);
}

/* ======= Water ======= */
function addWater(ml){
  const iso = getActiveDate();
  const day = ensureDay(iso);
  day.waterMl = safeNum(day.waterMl) + ml;
  day.lastWaterTs = Date.now();
  saveState();
  renderDashboard();
  toast(`נוסף ${ml} מ״ל 💧`);
}

function openCustomWater(){
  const ml = safeNum(prompt("כמה מ״ל להוסיף?", "250"), 0);
  if(ml>0) addWater(Math.round(ml));
}

function inQuietHours(){
  const q = state.settings.smartWater.quietHours;
  const h = new Date().getHours();
  // Quiet range could cross midnight (22 -> 7)
  if(q.from < q.to) return h >= q.from && h < q.to;
  return (h >= q.from) || (h < q.to);
}

function renderSmartHint(iso){
  const day = ensureDay(iso);
  if(day.restDay){ $("#smartHint").textContent = "יום חופשי פעיל: אין תזכורות/שיפוט ✅"; return; }

  const prof = state.user.profile;
  const day = ensureDay(iso);
  const goal = prof.waterGoalMl || 2000;
  const drank = safeNum(day.waterMl);
  const remaining = Math.max(0, goal - drank);

  const now = new Date();
  const end = new Date();
  end.setHours(22,0,0,0); // aim to finish by 22:00
  const minsLeft = Math.max(1, Math.round((end - now)/60000));
  const mlPerHour = Math.round((remaining / (minsLeft/60)));

  const hint = $("#smartHint");
  if(remaining<=0){
    hint.textContent = "סיימת יעד שתייה היום ✅";
  } else {
    hint.textContent = `כדי להספיק עד 22:00: בערך ${mlPerHour} מ״ל לשעה (נשארו ${remaining} מ״ל).`;
  }
}

async function toggleNotifications(){
  if(!("Notification" in window)){
    toast("הדפדפן לא תומך בהתראות.");
    return;
  }
  const enabled = state.settings.smartWater.enabled;
  if(!enabled){
    const perm = await Notification.requestPermission();
    if(perm !== "granted"){
      toast("אין הרשאה להתראות.");
      return;
    }
    state.settings.smartWater.enabled = true;
    saveState();
    toast("התראות שתייה הופעלו 🔔");
    // test
    notify("התראות שתייה הופעלו", "נשלח תזכורת חכמה כשצריך (לא בשעות שקט).");
  } else {
    state.settings.smartWater.enabled = false;
    saveState();
    toast("התראות שתייה כובו");
  }
  renderDashboard();
}

function tickSmartWater(){
  if(!state.user.profile) return;
  if(!state.settings.smartWater.enabled) return;
  if(inQuietHours()) return;

  const iso = getActiveDate();
  if(iso !== todayISO()) return; // only remind for today

  const day = ensureDay(iso);
  if(day.restDay) return;
  const prof = state.user.profile;

  const goal = prof.waterGoalMl || 2000;
  const drank = safeNum(day.waterMl);
  const remaining = goal - drank;

  if(remaining <= 0) return;

  // Smart logic:
  // - remind if no water logged for 90 min
  // - OR if behind schedule for the time of day
  const now = Date.now();
  const last = safeNum(day.lastWaterTs, 0);
  const minsSince = last ? (now - last)/60000 : 999;

  const hour = new Date().getHours();
  // expected progress curve: linear from 8:00 to 22:00
  const startH = 8, endH = 22;
  const clampedH = Math.min(endH, Math.max(startH, hour));
  const frac = (clampedH - startH) / (endH - startH);
  const expected = goal * frac;

  const behind = drank < expected - 250; // behind by at least 250ml

  if(minsSince >= 90 || behind){
    const title = "תזכורת שתייה 💧";
    const body = behind
      ? `אתה קצת מאחור ביעד. נשארו ${Math.max(0, Math.round(remaining))} מ״ל להיום.`
      : "לא רשמת שתייה כבר זמן מה. רוצה להוסיף 200–300 מ״ל?";
    notify(title, body);
    // throttle reminders: set lastWaterTs to now minus 60 min so it won't spam
    day.lastWaterTs = now - 30*60000;
    saveState();
  }
}

function notify(title, body){
  try{
    new Notification(title, { body, silent:true });
  }catch{
    // ignore
  }
}

/* ======= Settings ======= */
function openSettings(){
  if(!state.user.profile){
    toast("קודם צור פרופיל.");
    return;
  }

  const prof = state.user.profile;
  const body = document.createElement("div");
  body.className = "grid";
  body.innerHTML = `
    <div class="card" style="padding:12px; box-shadow:none">
      <div style="font-weight:900; margin-bottom:8px">יעד קלורי</div>
      <div class="muted small">כרגע: שמירה על משקל (Maintenance). בהמשך אפשר להוסיף חיטוב/מסה.</div>
      <div class="grid two" style="margin-top:10px">
        <label class="field">
          <span>יעד קלוריות יומי</span>
          <input id="setKcal" type="number" min="800" step="10" value="${round0(prof.kcalTarget)}">
        </label>
        <label class="field">
          <span>יעד מים (מ״ל)</span>
          <input id="setWater" type="number" min="500" step="50" value="${round0(prof.waterGoalMl)}">
        </label>
      </div>
    </div>

    <div class="card" style="padding:12px; box-shadow:none">
      <div style="font-weight:900; margin-bottom:8px">תזכורות שתייה</div>
      <div class="grid two">
        <label class="field">
          <span>שעות שקט (מ־)</span>
          <input id="qFrom" type="number" min="0" max="23" step="1" value="${state.settings.smartWater.quietHours.from}">
        </label>
        <label class="field">
          <span>שעות שקט (עד)</span>
          <input id="qTo" type="number" min="0" max="23" step="1" value="${state.settings.smartWater.quietHours.to}">
        </label>
      </div>
      <div class="muted small" style="margin-top:8px">ברירת מחדל: 22:00–07:00</div>
    </div>

    <div class="card note" style="padding:12px; box-shadow:none">
      <div style="font-weight:900; margin-bottom:8px">איפוס נתונים</div>
      <div class="muted small">מוחק את כל המידע במכשיר.</div>
      <button class="chip" id="resetBtn" style="margin-top:10px">איפוס מלא</button>
    </div>
  `;

  openModal("הגדרות", body, [
    makeBtn("עריכת פרופיל", "ghost", ()=>{ closeModal(); goEditProfile(); }),
    makeBtn("סגור", "ghost", closeModal),
    makeBtn("שמור", "primary", ()=>{
      prof.kcalTarget = Math.max(800, parseInt($("#setKcal").value,10)||prof.kcalTarget);
      prof.waterGoalMl = Math.max(500, parseInt($("#setWater").value,10)||prof.waterGoalMl);
      state.settings.smartWater.quietHours = {
        from: Math.min(23, Math.max(0, parseInt($("#qFrom").value,10)||22)),
        to: Math.min(23, Math.max(0, parseInt($("#qTo").value,10)||7))
      };
      saveState();
      closeModal();
      renderDashboard();
      toast("נשמר ✅");
    })
  ]);

  $("#resetBtn").addEventListener("click", ()=>{
    if(confirm("איפוס מלא? זה ימחק הכל.")){
      localStorage.removeItem(STORAGE_KEY);
      state = loadState();
      location.reload();
    }
  });
}

/* ======= Calorie estimation ======= */
const localFoodDbPer100g = [
  // name keywords, kcal, protein, carbs, fat (per 100g)
  {k:["אורז","rice"], kcal:130, p:2.7, c:28.2, f:0.3},
  {k:["פיתה","pita"], kcal:275, p:9.1, c:55, f:1.2}, // per 100g (approx)
  {k:["עוף","chicken"], kcal:165, p:31, c:0, f:3.6},
  {k:["סלמון","salmon"], kcal:208, p:20, c:0, f:13},
  {k:["ביצה","egg"], kcal:143, p:13, c:1.1, f:10},
  {k:["טונה","tuna"], kcal:132, p:29, c:0, f:1},
  {k:["לחם","bread"], kcal:265, p:9, c:49, f:3.2},
  {k:["גבינה","cheese"], kcal:280, p:18, c:2, f:23},
  {k:["יוגורט","yogurt"], kcal:60, p:3.5, c:4.7, f:3.3},
  {k:["סלט","salad"], kcal:35, p:1.5, c:7, f:0.2},
  {k:["בננה","banana"], kcal:89, p:1.1, c:23, f:0.3},
  {k:["תפוח","apple"], kcal:52, p:0.3, c:14, f:0.2},
  {k:["שוקולד","chocolate"], kcal:546, p:4.9, c:61, f:31},
  {k:["שמן","oil","זית"], kcal:884, p:0, c:0, f:100},
];

function findLocalFood(name){
  const n = (name||"").toLowerCase();
  return localFoodDbPer100g.find(item => item.k.some(k => n.includes(k.toLowerCase())));
}

async function estimateCalories({name, amount, unit, amountText}){
  try{
    if(unit !== "g"){
      // Can't reliably calculate from "2 pitas" without a database of units.
      // We'll attempt only if the food is a very known one (e.g., pita) and guess.
      const n = (name||"").toLowerCase();
      if(n.includes("פיתה") || n.includes("pita")){
        // If user typed "2", treat as count with 60g each
        const count = safeNum(amount, 0);
        if(count>0){
          const grams = count * 60;
          return estimateFromLocal(name, grams, "g");
        }
      }
      return null;
    }
    return await estimateFromLocalOrOnline(name, amount);
  }catch{
    return null;
  }
}

function estimateFromLocal(name, grams, unit="g"){
  const found = findLocalFood(name);
  if(!found) return null;
  const factor = grams / 100;
  return {
    kcal: Math.round(found.kcal * factor),
    protein: round1(found.p * factor),
    carbs: round1(found.c * factor),
    fat: round1(found.f * factor),
    source: "מאגר מקומי (ל-100g)"
  };
}

async function estimateFromLocalOrOnline(name, grams){
  const local = estimateFromLocal(name, grams);
  if(local) return local;

  // Optional: OpenFoodFacts search (works best for packaged products / barcodes).
  // Note: CORS is usually OK with their public API.
  if(state.settings.lookup.openFoodFacts){
    const off = await estimateViaOpenFoodFacts(name, grams);
    if(off) return off;
  }
  return null;
}

async function estimateViaOpenFoodFacts(name, grams){
  try{
    const q = encodeURIComponent(name);
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=10`;
    const res = await fetch(url, { mode:"cors" });
    if(!res.ok) return null;
    const data = await res.json();
    const p = (data.products || []).find(x => x.nutriments && (x.nutriments["energy-kcal_100g"] || x.nutriments["energy_100g"]));
    if(!p) return null;

    const kcal100 = safeNum(p.nutriments["energy-kcal_100g"], 0) ||
                    (safeNum(p.nutriments["energy_100g"], 0) / 4.184); // kJ->kcal
    if(!kcal100) return null;

    const protein100 = safeNum(p.nutriments["proteins_100g"], 0);
    const carbs100 = safeNum(p.nutriments["carbohydrates_100g"], 0);
    const fat100 = safeNum(p.nutriments["fat_100g"], 0);

    const factor = grams/100;
    return {
      kcal: Math.round(kcal100*factor),
      protein: round1(protein100*factor),
      carbs: round1(carbs100*factor),
      fat: round1(fat100*factor),
      source: "OpenFoodFacts (ל-100g)"
    };
  }catch{
    return null;
  }
}

/* ======= Photo helper ======= */
function fileToDataUrl(file, maxSize=1024){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ======= Export / Import ======= */
function exportData(){
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `healthy-lifestyle-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("קובץ גיבוי ירד ✅");
}
function importData(e){
  const file = e.target.files?.[0];
  if(!file) return;
  const r = new FileReader();
  r.onload = () => {
    try{
      const obj = JSON.parse(r.result);
      if(!obj || typeof obj !== "object") throw new Error("bad");
      state = { ...defaultState(), ...obj };
      saveState();
      toast("יובא בהצלחה ✅");
      renderDashboard();
    }catch{
      toast("קובץ לא תקין.");
    }
  };
  r.readAsText(file);
  e.target.value = "";
}

/* ======= PWA / Install ======= */
let deferredPrompt = null;
function initInstallPrompt(){
  window.addEventListener("beforeinstallprompt", (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    $("#installBtn").hidden = false;
  });
  $("#installBtn").addEventListener("click", async ()=>{
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("#installBtn").hidden = true;
  });
}

function registerSW(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
}

/* ======= Small UI helpers ======= */
function escapeHtml(str){
  return (str||"").replace(/[&<>"']/g, (c)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

let toastTimer = null;
function toast(msg){
  clearTimeout(toastTimer);
  let el = $("#_toast");
  if(!el){
    el = document.createElement("div");
    el.id = "_toast";
    el.style.position = "fixed";
    el.style.left = "14px";
    el.style.right = "14px";
    el.style.bottom = "16px";
    el.style.zIndex = "50";
    el.style.padding = "12px 14px";
    el.style.border = "1px solid rgba(255,255,255,.12)";
    el.style.background = "rgba(17,31,58,.95)";
    el.style.backdropFilter = "blur(10px)";
    el.style.borderRadius = "16px";
    el.style.boxShadow = "0 12px 35px rgba(0,0,0,.35)";
    el.style.color = "white";
    el.style.fontWeight = "700";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.transform = "translateY(0)";
  el.style.opacity = "1";
  toastTimer = setTimeout(()=>{
    el.style.opacity = "0";
  }, 2400);
}



/* ======= Modes: Eating Out + Rest Day ======= */
function toggleEatingOut(){
  state.user.modes = state.user.modes || { eatingOut:false };
  state.user.modes.eatingOut = !state.user.modes.eatingOut;
  saveState();
  toast(state.user.modes.eatingOut ? "מצב ארוחה בחוץ הופעל (±15%)" : "מצב ארוחה בחוץ כובה");
  renderDashboard();
}

function toggleRestDay(){
  const iso = getActiveDate();
  const day = ensureDay(iso);
  day.restDay = !day.restDay;
  // When rest day is on, disable smart reminders
  saveState();
  toast(day.restDay ? "יום חופשי הופעל ✅" : "יום חופשי כובה");
  renderDashboard();
}

/* ======= Favorites (Meal Bank) ======= */
function saveFoodAsFavorite(food){
  const fav = {
    id: crypto.randomUUID(),
    name: food.name,
    amount: food.amount,
    amountUnit: food.amountUnit,
    amountText: food.amountText,
    kcal: food.kcal,
    protein: food.protein || 0,
    carbs: food.carbs || 0,
    fat: food.fat || 0,
    fiber: food.fiber || 0,
    createdTs: Date.now()
  };
  state.user.favorites = state.user.favorites || [];
  state.user.favorites.unshift(fav);
  // keep up to 50
  state.user.favorites = state.user.favorites.slice(0,50);
  saveState();
  toast("נשמר בבנק הארוחות ⭐");
  renderFavoritesPreview();
}

function renderFavoritesPreview(){
  const wrap = document.getElementById("favoritesPreview");
  if(!wrap) return;
  const favs = (state.user.favorites || []).slice(0,3);
  wrap.innerHTML = "";
  if(!favs.length){
    wrap.innerHTML = `<div class="muted">אין עדיין ארוחות שמורות. לחץ ⭐ על פריט שאכלת.</div>`;
    return;
  }
  favs.forEach(f=>{
    const it = document.createElement("div");
    it.className = "item";
    const grams = f.amountUnit==="g" ? `${f.amount}g` : (f.amountText||"");
    it.innerHTML = `
      <div>
        <div class="title">${escapeHtml(f.name)}</div>
        <div class="sub">${escapeHtml(grams)} • ${round0(f.kcal||0)} kcal</div>
      </div>
      <div class="right">
        <button class="chip">+ הוסף</button>
      </div>
    `;
    it.querySelector("button").addEventListener("click", ()=>{
      addFavoriteToDay(f);
    });
    wrap.appendChild(it);
  });
}

function addFavoriteToDay(fav){
  const iso = getActiveDate();
  const day = ensureDay(iso);
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    name: fav.name,
    amount: fav.amount,
    amountUnit: fav.amountUnit,
    amountText: fav.amountText,
    kcal: fav.kcal,
    protein: fav.protein,
    carbs: fav.carbs,
    fat: fav.fat,
    fiber: fav.fiber,
    photoDataUrl: "",
    photoNotes: "",
    source: "favorite"
  };
  day.foods.push(entry);
  saveState();
  renderDashboard();
  toast("נוסף מהבנק ✅");
}

function openFavoritesModal(){
  const favs = (state.user.favorites || []);
  const body = document.createElement("div");
  body.className = "grid";

  const top = document.createElement("div");
  top.className = "row gap wrap";
  top.innerHTML = `
    <button class="chip" id="favAddNewTip">איך שומרים?</button>
    <button class="chip" id="favClearAll">מחיקת הכל</button>
  `;
  body.appendChild(top);

  const list = document.createElement("div");
  list.className = "list";
  if(!favs.length){
    list.innerHTML = `<div class="muted">אין ארוחות שמורות עדיין. כדי לשמור: במסך הראשי לחץ ⭐ ליד פריט שאכלת.</div>`;
  } else {
    favs.forEach(f=>{
      const it = document.createElement("div");
      it.className = "item";
      const grams = f.amountUnit==="g" ? `${f.amount}g` : (f.amountText||"");
      it.innerHTML = `
        <div>
          <div class="title">${escapeHtml(f.name)}</div>
          <div class="sub">${escapeHtml(grams)} • ${round0(f.kcal||0)} kcal • P ${round0(f.protein||0)} • C ${round0(f.carbs||0)} • F ${round0(f.fat||0)}</div>
        </div>
        <div class="right">
          <div class="actions">
            <button class="chip" data-act="add">+ הוסף</button>
            <button class="chip" data-act="del">מחק</button>
          </div>
        </div>
      `;
      it.querySelector('[data-act="add"]').addEventListener("click", ()=>addFavoriteToDay(f));
      it.querySelector('[data-act="del"]').addEventListener("click", ()=>{
        if(confirm("למחוק מהבנק?")){
          state.user.favorites = state.user.favorites.filter(x=>x.id!==f.id);
          saveState();
          closeModal();
          openFavoritesModal();
          renderFavoritesPreview();
        }
      });
      list.appendChild(it);
    });
  }
  body.appendChild(list);

  openModal("בנק ארוחות", body, [
    makeBtn("סגור", "primary", closeModal)
  ]);

  const tipBtn = document.getElementById("favAddNewTip");
  if(tipBtn) tipBtn.addEventListener("click", ()=>{
    toast("שמור ארוחה: לחץ ⭐ ליד פריט שאכלת");
  });
  const clearBtn = document.getElementById("favClearAll");
  if(clearBtn) clearBtn.addEventListener("click", ()=>{
    if(confirm("למחוק את כל בנק הארוחות?")){
      state.user.favorites = [];
      saveState();
      closeModal();
      renderFavoritesPreview();
      toast("נמחק ✅");
    }
  });
}

/* ======= Weight tracking ======= */
function openWeightModal(){
  const body = document.createElement("div");
  body.className = "grid";
  const weights = (state.user.weights || []).slice().sort((a,b)=> (b.ts||0)-(a.ts||0));

  body.innerHTML = `
    <div class="grid two">
      <label class="field">
        <span>תאריך (YYYY-MM-DD)</span>
        <input id="wDate" type="text" value="${todayISO()}" inputmode="numeric" placeholder="2026-01-05">
      </label>
      <label class="field">
        <span>משקל (ק״ג)</span>
        <input id="wKg" type="number" min="30" max="300" step="0.1" inputmode="decimal" placeholder="לדוגמה: 82.5">
      </label>
    </div>
    <div class="muted small">טיפ: שקילה פעם בשבוע באותה שעה/תנאים.</div>
    <div class="sep"></div>
    <div class="list" id="weightsList"></div>
  `;

  openModal("משקל", body, [
    makeBtn("סגור", "ghost", closeModal),
    makeBtn("שמור", "primary", ()=>{
      const dateISO = (document.getElementById("wDate").value||"").trim();
      const kg = safeNum(document.getElementById("wKg").value, 0);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)){ toast("תאריך לא תקין."); return; }
      if(!kg){ toast("מלא משקל."); return; }
      state.user.weights = state.user.weights || [];
      // replace existing date if exists
      state.user.weights = state.user.weights.filter(w=>w.dateISO!==dateISO);
      state.user.weights.push({ dateISO, kg: round1(kg), ts: Date.now() });
      saveState();
      closeModal();
      renderWeightCard();
      toast("נשמר ✅");
    })
  ]);

  const listEl = document.getElementById("weightsList");
  if(listEl){
    if(!weights.length){
      listEl.innerHTML = `<div class="muted">אין עדיין שקילות.</div>`;
    } else {
      weights.slice(0,12).forEach(w=>{
        const it = document.createElement("div");
        it.className = "item";
        it.innerHTML = `
          <div>
            <div class="title">${fmtDate(w.dateISO)}</div>
            <div class="sub">${w.dateISO}</div>
          </div>
          <div class="right">
            <div class="kcal">${round1(w.kg)} ק״ג</div>
            <div class="actions">
              <button class="chip" data-act="del">מחק</button>
            </div>
          </div>
        `;
        it.querySelector('[data-act="del"]').addEventListener("click", ()=>{
          if(confirm("למחוק שקילה?")){
            state.user.weights = (state.user.weights||[]).filter(x=>x.dateISO!==w.dateISO);
            saveState();
            closeModal();
            openWeightModal();
            renderWeightCard();
          }
        });
        listEl.appendChild(it);
      });
    }
  }
}

function renderWeightCard(){
  const lastEl = document.getElementById("lastWeight");
  const trendEl = document.getElementById("weightTrend");
  const hintEl = document.getElementById("weighInHint");
  const barEl = document.getElementById("weighInBar");
  if(!lastEl || !trendEl || !hintEl || !barEl) return;

  const weights = (state.user.weights || []).slice().sort((a,b)=> (a.dateISO > b.dateISO ? 1 : -1));
  if(!weights.length){
    lastEl.textContent = "—";
    trendEl.textContent = "—";
    hintEl.textContent = "אין שקילות";
    barEl.style.width = "0%";
    return;
  }
  const last = weights[weights.length-1];
  lastEl.textContent = `${round1(last.kg)}`;

  // Trend: compare last 28 days average to previous 28 days average
  const now = new Date();
  const cut = new Date(now.getTime() - 28*24*3600*1000);
  const cut2 = new Date(now.getTime() - 56*24*3600*1000);

  const wIn = (from, to) => weights.filter(w=>{
    const d = new Date(w.dateISO+"T00:00:00");
    return d >= from && d < to;
  }).map(w=>w.kg);

  const curr = wIn(cut, now);
  const prev = wIn(cut2, cut);

  const avg = (arr)=> arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null;

  const a1 = avg(curr);
  const a0 = avg(prev);

  if(a1!=null && a0!=null){
    const diff = round1(a1 - a0);
    trendEl.textContent = diff===0 ? "0.0" : (diff>0 ? `+${diff}` : `${diff}`);
  } else {
    trendEl.textContent = "—";
  }

  // Weekly consistency: how many of last 28 days have a weigh-in (max 4 expected)
  const currDates = new Set(curr.map(()=>1));
  const n = curr.length;
  const pct = Math.min(100, (n/4)*100);
  barEl.style.width = pct + "%";
  hintEl.textContent = n>=4 ? "מעולה" : `יש ${n} שקילות ב־28 יום`;
}

/* ======= Profile editing ======= */
function goEditProfile(){
  showScreen("#screenProfile");
  // Prefill
  const p = state.user.profile;
  if(!p) return;
  document.getElementById("profileNamePill").textContent = state.user.name;
  document.getElementById("ageInput").value = p.age;
  document.getElementById("genderInput").value = p.gender;
  document.getElementById("heightInput").value = p.heightCm;
  document.getElementById("weightInput").value = p.weightKg;
  document.getElementById("activityInput").value = p.activityFactor;
  document.getElementById("waterGoalInput").value = round1((p.waterGoalMl||0)/1000);
}

document.addEventListener("DOMContentLoaded", init);
