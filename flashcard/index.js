/** SHARED UTILITIES */
const Utils = {
  id: (id) => document.getElementById(id),
  show: (el) => el.classList.remove('hidden'),
  hide: (el) => el.classList.add('hidden'),
  val: (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; },
  setVal: (id, val) => { const el = document.getElementById(id); if (el) el.value = val; },
  
  createCard: (hanzi, pinyin, vietnamese) => ({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    hanzi, pinyin, vietnamese,
    reps: 0, interval: 0, ef: 2.5, 
    nextReview: new Date().toISOString()
  })
};

/** DATABASE MODULE */
const DB_KEY = 'srs_db_v3';
const DB = {
  getAll: () => JSON.parse(localStorage.getItem(DB_KEY) || '[]'),
  save: (data) => localStorage.setItem(DB_KEY, JSON.stringify(data)),
  
  add: (hanzi, pinyin, vietnamese) => {
    const data = DB.getAll();
    data.push(Utils.createCard(hanzi, pinyin, vietnamese));
    DB.save(data);
  },

  update: (id, updatedData) => {
    const data = DB.getAll();
    const index = data.findIndex(c => c.id === id);
    if (index !== -1) {
      // Merge existing technical data (reps/interval) with new content
      data[index] = { ...data[index], ...updatedData };
      DB.save(data);
    }
  },

  delete: (id) => {
    let data = DB.getAll();
    data = data.filter(c => c.id !== id);
    DB.save(data);
  }
};

/** SM-2 ALGORITHM */
const Scheduler = {
  calculate: (card, grade) => {
    let { reps, interval, ef } = card;
    if (grade >= 3) {
      if (reps === 0) interval = 1;
      else if (reps === 1) interval = 6;
      else interval = Math.round(interval * ef);
      reps++;
    } else { reps = 0; interval = 1; }
    ef = ef + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
    if (ef < 1.3) ef = 1.3;
    const d = new Date(); d.setDate(d.getDate() + interval); d.setHours(0,0,0,0);
    return { ...card, reps, interval, ef, nextReview: d.toISOString() };
  }
};

/** TRANSLATION API */
const Translator = {
  fetch: async (text) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=vi&dt=t&dt=rm&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      const data = await res.json();
      let viet = "", pin = "";
      if (data && data[0]) {
        data[0].forEach(p => { if (p[0]) viet += p[0]; });
        const last = data[0][data[0].length - 1];
        if (Array.isArray(last) && last.length >= 2) pin = last[2] || last[3] || "";
      }
      return { pinyin: pin, vietnamese: viet };
    } catch (e) { return null; }
  }
};

/** DATA MANAGER */
const DataMgr = {
  export: () => {
    const data = DB.getAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chinese_srs_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  },
  import: (input) => {
    const f = input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        if (Array.isArray(json) && confirm(`Import ${json.length} cards?`)) {
          DB.save(json);
          alert("Restored!");
          location.reload();
        }
      } catch (err) { alert("Invalid File"); }
    };
    r.readAsText(f);
  },
  clear: () => { if(confirm("Delete ALL data?")) { localStorage.removeItem(DB_KEY); location.reload(); } }
};

/** APP CONTROLLER */
const App = {
  dueCards: [], currentIdx: 0,

  init: () => { App.setView('review'); App.updateStats(); },

  updateStats: () => {
    const cards = DB.getAll();
    const today = new Date().toISOString();
    const due = cards.filter(c => c.nextReview <= today).length;
    if(Utils.id('stat-total')) Utils.id('stat-total').innerText = cards.length;
    if(Utils.id('stat-due')) Utils.id('stat-due').innerText = due;
  },

  setView: (v) => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    if(Utils.id('nav-'+v)) Utils.id('nav-'+v).classList.add('active');
    
    ['review', 'add', 'list', 'settings'].forEach(id => Utils.hide(Utils.id('view-'+id)));
    Utils.show(Utils.id('view-'+v));

    if(v === 'review') App.loadSession();
    if(v === 'list') App.renderList();
    if(v === 'settings') App.updateStats();
  },

  /* --- REVIEW LOGIC --- */
  loadSession: () => {
    const cards = DB.getAll();
    const today = new Date().toISOString();
    App.dueCards = cards.filter(c => c.nextReview <= today);
    App.currentIdx = 0;
    App.renderReviewCard();
  },
  renderReviewCard: () => {
    const ui = Utils.id('review-ui');
    const msg = Utils.id('status-msg');
    
    if (App.dueCards.length === 0) {
      Utils.hide(ui);
      msg.innerHTML = `<div style="font-size:3rem">🎉</div><h2>All Caught Up!</h2><p style="color:#666">No cards due.</p>`;
      return;
    }
    if (App.currentIdx >= App.dueCards.length) {
      Utils.hide(ui);
      msg.innerHTML = `<div style="font-size:3rem">✅</div><h2>Session Complete</h2>`;
      return;
    }
    msg.innerHTML = '';
    Utils.show(ui);
    const c = App.dueCards[App.currentIdx];
    Utils.id('d-hanzi').innerText = c.hanzi;
    Utils.id('d-pinyin').innerText = c.pinyin;
    Utils.id('d-viet').innerText = c.vietnamese;
    Utils.hide(Utils.id('back'));
    Utils.show(Utils.id('btn-reveal'));
    Utils.hide(Utils.id('grade-options'));
  },
  reveal: () => {
    Utils.show(Utils.id('back'));
    Utils.hide(Utils.id('btn-reveal'));
    Utils.show(Utils.id('grade-options'));
    App.playAudio();
  },
  grade: (g) => {
    const c = App.dueCards[App.currentIdx];
    const updated = Scheduler.calculate(c, g);
    DB.update(c.id, updated);
    App.currentIdx++;
    App.renderReviewCard();
  },
  playAudio: () => {
    const txt = Utils.id('d-hanzi').innerText;
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(txt);
      u.lang = 'zh-CN';
      window.speechSynthesis.speak(u);
    }
  },

  /* --- ADD & IMPORT --- */
  autoFill: async () => {
    const h = Utils.val('in-hanzi');
    if(!h) return;
    const res = await Translator.fetch(h);
    if(res) { Utils.setVal('in-pinyin', res.pinyin); Utils.setVal('in-viet', res.vietnamese); }
    else alert("Check internet connection");
  },
  addCard: (e) => {
    e.preventDefault();
    if(Utils.val('in-hanzi')) {
      DB.add(Utils.val('in-hanzi'), Utils.val('in-pinyin'), Utils.val('in-viet'));
      alert('Saved!'); e.target.reset();
    }
  },
  bulkImport: async () => {
    const txt = Utils.val('bulk-text');
    if(!txt) return;
    const lines = txt.split(/[,\n，]+/).map(w=>w.trim()).filter(w=>w);
    const btn = Utils.id('btn-bulk');
    btn.disabled = true;
    let count = 0;
    for(let w of lines) {
      const res = await Translator.fetch(w);
      if(res) { DB.add(w, res.pinyin, res.vietnamese); count++; }
      await new Promise(r => setTimeout(r, 1000));
    }
    alert(`Imported ${count} cards!`);
    btn.disabled = false;
    Utils.setVal('bulk-text', '');
  },

  /* --- LIST & EDIT --- */
  renderList: () => {
    const query = Utils.val('search-input').toLowerCase();
    const cards = DB.getAll().reverse(); // Show newest first
    const container = Utils.id('card-list-container');
    container.innerHTML = '';

    const filtered = cards.filter(c => 
      c.hanzi.toLowerCase().includes(query) || 
      c.pinyin.toLowerCase().includes(query) || 
      c.vietnamese.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#999">No cards found.</p>';
      return;
    }

    filtered.forEach(c => {
      const div = document.createElement('div');
      div.className = 'card-item';
      div.innerHTML = `
        <div class="card-info">
          <div class="card-hanzi">${c.hanzi}</div>
          <div class="card-details">${c.pinyin} • ${c.vietnamese}</div>
        </div>
        <div class="card-actions">
          <button class="icon-btn btn-edit" onclick="App.openEdit('${c.id}')">✏️</button>
          <button class="icon-btn btn-delete" onclick="App.deleteCard('${c.id}')">🗑️</button>
        </div>
      `;
      container.appendChild(div);
    });
  },

  deleteCard: (id) => {
    if(confirm("Delete this card?")) {
      DB.delete(id);
      App.renderList();
    }
  },

  openEdit: (id) => {
    const cards = DB.getAll();
    const card = cards.find(c => c.id === id);
    if (card) {
      Utils.setVal('edit-id', card.id);
      Utils.setVal('edit-hanzi', card.hanzi);
      Utils.setVal('edit-pinyin', card.pinyin);
      Utils.setVal('edit-viet', card.vietnamese);
      Utils.show(Utils.id('edit-modal'));
    }
  },

  closeModal: () => {
    Utils.hide(Utils.id('edit-modal'));
  },

  saveEdit: (e) => {
    e.preventDefault();
    const id = Utils.val('edit-id');
    const updatedData = {
      hanzi: Utils.val('edit-hanzi'),
      pinyin: Utils.val('edit-pinyin'),
      vietnamese: Utils.val('edit-viet')
    };
    DB.update(id, updatedData);
    App.closeModal();
    App.renderList(); // Refresh list to show changes
  }
};

window.onload = App.init;
