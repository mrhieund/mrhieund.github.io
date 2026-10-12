/**
 * Chinese Flashcards App - SRS with Smart HSK Bulk Importer
 */

/** 1. SHARED UTILITIES */
const Utils = {
  id: (id) => document.getElementById(id),
  show: (el) => { if (el) el.classList.remove('hidden'); },
  hide: (el) => { if (el) el.classList.add('hidden'); },
  val: (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; },
  setVal: (id, val) => { const el = document.getElementById(id); if (el) el.value = val; },

  showToast: (msg, duration = 3000) => {
    const toast = Utils.id('toast');
    if (!toast) return;
    toast.innerHTML = msg;
    Utils.show(toast);
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      Utils.hide(toast);
    }, duration);
  },

  createCard: (hanzi, pinyin, vietnamese, hsk = null) => {
    // If HSK level not explicitly passed, attempt to detect from dictionary
    const detectedHsk = hsk !== null && hsk !== undefined && hsk !== ''
      ? parseInt(hsk, 10)
      : HSKManager.getLevel(hanzi);

    return {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      hanzi: hanzi.trim(),
      pinyin: pinyin.trim(),
      vietnamese: vietnamese.trim(),
      hsk: detectedHsk || null,
      reps: 0,
      interval: 0,
      ef: 2.5,
      nextReview: new Date().toISOString()
    };
  }
};

/** 2. DATABASE MODULE */
const DB_KEY = 'srs_db_v4';
const DB = {
  getAll: () => {
    try {
      const data = JSON.parse(localStorage.getItem(DB_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  },

  save: (data) => {
    localStorage.setItem(DB_KEY, JSON.stringify(data));
  },

  add: (hanzi, pinyin, vietnamese, hsk = null) => {
    const data = DB.getAll();
    const newCard = Utils.createCard(hanzi, pinyin, vietnamese, hsk);
    data.push(newCard);
    DB.save(data);
    return newCard;
  },

  addBatch: (cardsArray) => {
    const data = DB.getAll();
    let count = 0;
    cardsArray.forEach(c => {
      data.push(Utils.createCard(c.hanzi, c.pinyin, c.vietnamese, c.hsk));
      count++;
    });
    DB.save(data);
    return count;
  },

  update: (id, updatedData) => {
    const data = DB.getAll();
    const index = data.findIndex(c => c.id === id);
    if (index !== -1) {
      data[index] = { ...data[index], ...updatedData };
      DB.save(data);
    }
  },

  delete: (id) => {
    let data = DB.getAll();
    data = data.filter(c => c.id !== id);
    DB.save(data);
  },

  has: (hanzi) => {
    const data = DB.getAll();
    const target = hanzi.trim();
    return data.some(c => c.hanzi.trim() === target);
  }
};

/** 3. SM-2 SPACED REPETITION ALGORITHM */
const Scheduler = {
  calculate: (card, grade) => {
    let { reps, interval, ef } = card;
    if (grade >= 3) {
      if (reps === 0) interval = 1;
      else if (reps === 1) interval = 6;
      else interval = Math.round(interval * ef);
      reps++;
    } else {
      reps = 0;
      interval = 1;
    }
    ef = ef + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
    if (ef < 1.3) ef = 1.3;
    const d = new Date();
    d.setDate(d.getDate() + interval);
    d.setHours(0, 0, 0, 0);
    return { ...card, reps, interval, ef, nextReview: d.toISOString() };
  }
};

/** 4. TRANSLATION API (Google Translate Single & Batch) */
const Translator = {
  fetch: async (text) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=vi&dt=t&dt=rm&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      const data = await res.json();
      let viet = '', pin = '';
      if (data && data[0]) {
        data[0].forEach(p => { if (p[0]) viet += p[0]; });
        const last = data[0][data[0].length - 1];
        if (Array.isArray(last) && last.length >= 2) pin = last[2] || last[3] || '';
      }
      return { pinyin: pin.trim(), vietnamese: viet.trim() };
    } catch (e) {
      return null;
    }
  },

  fetchBatch: async (words, onProgress) => {
    const results = {};
    const batchSize = 12; // Moderate batch size for reliable parsing
    for (let i = 0; i < words.length; i += batchSize) {
      const chunk = words.slice(i, i + batchSize);
      const joined = chunk.join('\n');
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=vi&dt=t&dt=rm&q=${encodeURIComponent(joined)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data && data[0]) {
          let fullTrans = '';
          data[0].forEach(p => { if (p[0]) fullTrans += p[0]; });
          const transLines = fullTrans.split('\n');

          let fullPinyin = '';
          const last = data[0][data[0].length - 1];
          if (Array.isArray(last) && last.length >= 2) {
            fullPinyin = last[2] || last[3] || '';
          }
          const pinyinLines = fullPinyin.split('\n');

          chunk.forEach((word, idx) => {
            results[word] = {
              vietnamese: (transLines[idx] || '').trim(),
              pinyin: (pinyinLines[idx] || '').trim()
            };
          });
        }
      } catch (err) {
        console.warn('Batch translation fallback to single for chunk', err);
        for (const word of chunk) {
          const single = await Translator.fetch(word);
          if (single) results[word] = single;
          await new Promise(r => setTimeout(r, 200));
        }
      }

      if (onProgress) {
        onProgress(Math.min(i + batchSize, words.length), words.length);
      }
      if (i + batchSize < words.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return results;
  }
};

/** 5. HSK VOCABULARY MANAGER & SEGMENTATION ENGINE */
const HSKManager = {
  dict: {}, // Key: Chinese word -> { lvl: 1-7, pinyin: string, def: string }
  isLoaded: false,
  isLoading: false,

  // Fallback Baseline: Core HSK 1 and 2 common vocabulary (instantly available offline)
  baseline: {
    "爱": [1, "ài", "to love; affection"],
    "八": [1, "bā", "eight"],
    "爸爸": [1, "bà ba", "dad; father"],
    "杯子": [1, "bēi zi", "cup; glass"],
    "北京": [1, "Běi jīng", "Beijing"],
    "本": [1, "běn", "classifier for books"],
    "不": [1, "bù", "no; not"],
    "不客气": [1, "bù kè qi", "you're welcome"],
    "菜": [1, "cài", "dish; vegetable"],
    "茶": [1, "chá", "tea"],
    "吃": [1, "chī", "to eat"],
    "出租车": [1, "chū zū chē", "taxi"],
    "打电话": [1, "dǎ diàn huà", "to make a call"],
    "大": [1, "dà", "big; large"],
    "的": [1, "de", "possessive particle"],
    "点": [1, "diǎn", "o'clock; dot"],
    "电脑": [1, "diàn nǎo", "computer"],
    "电视": [1, "diàn shì", "television"],
    "电影": [1, "diàn yǐng", "movie; film"],
    "东西": [1, "dōng xi", "thing; stuff"],
    "都": [1, "dōu", "all; both"],
    "读": [1, "dú", "to read"],
    "对不起": [1, "duì bu qǐ", "sorry"],
    "多": [1, "duō", "many; much"],
    "多少": [1, "duō shao", "how many"],
    "儿子": [1, "ér zi", "son"],
    "二": [1, "èr", "two"],
    "饭馆": [1, "fàn guǎn", "restaurant"],
    "飞机": [1, "fēi jī", "airplane"],
    "分钟": [1, "fēn zhōng", "minute"],
    "高兴": [1, "gāo xìng", "happy; glad"],
    "个": [1, "gè", "general classifier"],
    "工作": [1, "gōng zuò", "job; work"],
    "狗": [1, "gǒu", "dog"],
    "汉语": [1, "Hàn yǔ", "Chinese language"],
    "好": [1, "hǎo", "good; well"],
    "喝": [1, "hē", "to drink"],
    "和": [1, "hé", "and; with"],
    "很": [1, "hěn", "very"],
    "后面": [1, "hòu mian", "behind"],
    "回": [1, "huí", "to return"],
    "会": [1, "huì", "can; be able to"],
    "几": [1, "jǐ", "how many"],
    "家": [1, "jiā", "family; home"],
    "叫": [1, "jiào", "to call; be called"],
    "今天": [1, "jīn tiān", "today"],
    "九": [1, "jiǔ", "nine"],
    "开": [1, "kāi", "to open; drive"],
    "看": [1, "kàn", "to look; watch"],
    "看见": [1, "kàn jiàn", "to see"],
    "块": [1, "kuài", "yuan; piece"],
    "来": [1, "lái", "to come"],
    "老师": [1, "lǎo shī", "teacher"],
    "了": [1, "le", "particle"],
    "冷": [1, "lěng", "cold"],
    "里": [1, "lǐ", "inside"],
    "零": [1, "líng", "zero"],
    "六": [1, "liù", "six"],
    "妈妈": [1, "mā ma", "mother"],
    "吗": [1, "ma", "question particle"],
    "买": [1, "mǎi", "to buy"],
    "猫": [1, "māo", "cat"],
    "没": [1, "méi", "not have"],
    "没关系": [1, "méi guān xi", "it doesn't matter"],
    "米饭": [1, "mǐ fàn", "cooked rice"],
    "明天": [1, "míng tiān", "tomorrow"],
    "名字": [1, "míng zi", "name"],
    "哪": [1, "nǎ", "which"],
    "哪儿": [1, "nǎ r", "where"],
    "那": [1, "nà", "that"],
    "那儿": [1, "nà r", "there"],
    "呢": [1, "ne", "particle"],
    "能": [1, "néng", "can; be able"],
    "你": [1, "nǐ", "you"],
    "年": [1, "nián", "year"],
    "女儿": [1, "nǚ ér", "daughter"],
    "朋友": [1, "péng you", "friend"],
    "漂亮": [1, "piào liang", "beautiful"],
    "苹果": [1, "píng guǒ", "apple"],
    "七": [1, "qī", "seven"],
    "钱": [1, "qián", "money"],
    "前面": [1, "qián mian", "front"],
    "请": [1, "qǐng", "please"],
    "去": [1, "qù", "to go"],
    "热": [1, "rè", "hot"],
    "人": [1, "rén", "person"],
    "认识": [1, "rèn shi", "to know"],
    "三": [1, "sān", "three"],
    "商店": [1, "shāng diàn", "shop"],
    "上": [1, "shàng", "up; on"],
    "上午": [1, "shàng wǔ", "morning"],
    "少": [1, "shǎo", "few; little"],
    "谁": [1, "shéi", "who"],
    "什么": [1, "shén me", "what"],
    "十": [1, "shí", "ten"],
    "时候": [1, "shí hou", "time"],
    "是": [1, "shì", "to be"],
    "书": [1, "shū", "book"],
    "水": [1, "shuǐ", "water"],
    "水果": [1, "shuǐ guǒ", "fruit"],
    "睡觉": [1, "shuì jiào", "to sleep"],
    "说": [1, "shuō", "to speak"],
    "说话": [1, "shuō huà", "to talk"],
    "四": [1, "sì", "four"],
    "岁": [1, "suì", "years old"],
    "他": [1, "tā", "he"],
    "她": [1, "tā", "she"],
    "太": [1, "tài", "too; extremely"],
    "天气": [1, "tiān qì", "weather"],
    "听": [1, "tīng", "to listen"],
    "同学": [1, "tóng xué", "classmate"],
    "喂": [1, "wèi", "hello"],
    "我": [1, "wǒ", "I; me"],
    "我们": [1, "wǒ men", "we; us"],
    "五": [1, "wǔ", "five"],
    "喜欢": [1, "xǐ huan", "to like"],
    "下": [1, "xià", "down; below"],
    "下午": [1, "xià wǔ", "afternoon"],
    "下雨": [1, "xià yǔ", "to rain"],
    "先生": [1, "xiān sheng", "sir; Mr."],
    "现在": [1, "xiàn zài", "now"],
    "想": [1, "xiǎng", "to think; want"],
    "小": [1, "xiǎo", "small"],
    "小姐": [1, "xiǎo jie", "miss; lady"],
    "些": [1, "xiē", "some"],
    "写": [1, "xiě", "to write"],
    "谢谢": [1, "xiè xie", "thanks"],
    "星期": [1, "xīng qī", "week"],
    "学生": [1, "xué sheng", "student"],
    "学习": [1, "xué xí", "to study"],
    "学校": [1, "xué xiào", "school"],
    "一": [1, "yī", "one"],
    "衣服": [1, "yī fu", "clothes"],
    "医生": [1, "yī shēng", "doctor"],
    "医院": [1, "yī yuàn", "hospital"],
    "椅子": [1, "yǐ zi", "chair"],
    "有": [1, "yǒu", "to have"],
    "月": [1, "yuè", "month; moon"],
    "再见": [1, "zài jiàn", "goodbye"],
    "在": [1, "zài", "at; in"],
    "怎么": [1, "zěn me", "how"],
    "怎么样": [1, "zěn me yàng", "how about"],
    "这": [1, "zhè", "this"],
    "这儿": [1, "zhè r", "here"],
    "中国": [1, "Zhōng guó", "China"],
    "中午": [1, "zhōng wǔ", "noon"],
    "住": [1, "zhù", "to live"],
    "桌子": [1, "zhuō zi", "table; desk"],
    "字": [1, "zì", "character"],
    "昨天": [1, "zuó tiān", "yesterday"],
    "坐": [1, "zuò", "to sit"],
    "做": [1, "zuò", "to do; make"],
    // Common HSK 2 words
    "吧": [2, "ba", "suggestion particle"],
    "白": [2, "bái", "white"],
    "百": [2, "bǎi", "hundred"],
    "帮助": [2, "bāng zhù", "to help"],
    "报纸": [2, "bào zhǐ", "newspaper"],
    "比": [2, "bǐ", "compare; than"],
    "别": [2, "bié", "don't; other"],
    "长": [2, "cháng", "long"],
    "唱歌": [2, "chàng gē", "to sing"],
    "出": [2, "chū", "to exit; go out"],
    "穿": [2, "chuān", "to wear"],
    "次": [2, "cì", "time; frequency"],
    "从": [2, "cóng", "from"],
    "错": [2, "cuò", "wrong; error"],
    "打篮球": [2, "dǎ lán qiú", "play basketball"],
    "大家": [2, "dà jiā", "everyone"],
    "到": [2, "dào", "to arrive"],
    "得": [2, "de", "particle"],
    "等": [2, "děng", "to wait"],
    "弟弟": [2, "dì di", "younger brother"],
    "第一": [2, "dì yī", "first"],
    "懂": [2, "dǒng", "to understand"],
    "对": [2, "duì", "correct; towards"],
    "房间": [2, "fáng jiān", "room"],
    "非常": [2, "fēi cháng", "very; extremely"],
    "服务员": [2, "fú wù yuán", "waiter"],
    "高": [2, "gāo", "tall; high"],
    "告诉": [2, "gào su", "to tell"],
    "哥哥": [2, "gē ge", "elder brother"],
    "给": [2, "gěi", "to give; for"],
    "公共汽车": [2, "gōng gòng qì chē", "bus"],
    "公司": [2, "gōng sī", "company"],
    "贵": [2, "guì", "expensive"],
    "过": [2, "guo", "aspect particle"],
    "还": [2, "hái", "still; yet; also"],
    "孩子": [2, "hái zi", "child"],
    "好吃": [2, "hǎo chī", "delicious"],
    "黑": [2, "hēi", "black"],
    "红": [2, "hóng", "red"],
    "欢迎": [2, "huān yíng", "welcome"],
    "回答": [2, "huí dá", "to answer"],
    "机场": [2, "jī chǎng", "airport"],
    "鸡蛋": [2, "jī dàn", "egg"],
    "件": [2, "jiàn", "classifier"],
    "教室": [2, "jiào shì", "classroom"],
    "姐姐": [2, "jiě jie", "elder sister"],
    "介绍": [2, "jiè shào", "to introduce"],
    "进": [2, "jìn", "to enter"],
    "近": [2, "jìn", "near; close"],
    "就": [2, "jiù", "then; at once"],
    "觉得": [2, "jué de", "to feel; think"],
    "咖啡": [2, "kā fēi", "coffee"],
    "开始": [2, "kāi shǐ", "to begin; start"],
    "考试": [2, "kǎo shì", "exam; test"],
    "可能": [2, "kě néng", "maybe; possible"],
    "可以": [2, "kě yǐ", "can; may"],
    "课": [2, "kè", "lesson; class"],
    "快": [2, "kuài", "fast; soon"],
    "快乐": [2, "kuài lè", "happy"],
    "累": [2, "lèi", "tired"],
    "离": [2, "lí", "away from"],
    "两": [2, "liǎng", "two"],
    "路": [2, "lù", "road"],
    "旅游": [2, "lǚ yóu", "travel; tour"],
    "卖": [2, "mài", "to sell"],
    "慢": [2, "màn", "slow"],
    "忙": [2, "máng", "busy"],
    "每": [2, "měi", "every; each"],
    "妹妹": [2, "mèi mei", "younger sister"],
    "门": [2, "mén", "door"],
    "面条": [2, "miàn tiáo", "noodles"],
    "男": [2, "nán", "male"],
    "您": [2, "nín", "you (polite)"],
    "牛奶": [2, "niú nǎi", "milk"],
    "女": [2, "nǚ", "female"],
    "旁边": [2, "páng biān", "beside"],
    "跑步": [2, "pǎo bù", "to run; jog"],
    "便宜": [2, "pián yi", "cheap"],
    "票": [2, "piào", "ticket"],
    "妻子": [2, "qī zi", "wife"],
    "起床": [2, "qǐ chuáng", "get out of bed"],
    "千": [2, "qiān", "thousand"],
    "铅笔": [2, "qiān bǐ", "pencil"],
    "晴": [2, "qíng", "sunny; clear"],
    "去年": [2, "qù nián", "last year"],
    "让": [2, "ràng", "to let; allow"],
    "日": [2, "rì", "day; sun"],
    "上班": [2, "shàng bān", "go to work"],
    "身体": [2, "shēn tǐ", "body; health"],
    "生病": [2, "shēng bìng", "fall ill"],
    "生日": [2, "shēng rì", "birthday"],
    "时间": [2, "shí jiān", "time"],
    "事情": [2, "shì qing", "thing; affair"],
    "手表": [2, "shǒu biǎo", "wrist watch"],
    "手机": [2, "shǒu jī", "mobile phone"],
    "送": [2, "sòng", "to send; deliver"],
    "虽然": [2, "suī rán", "although"],
    "但是": [2, "dàn shì", "but; however"],
    "它": [2, "tā", "it"],
    "踢足球": [2, "tī zú qiú", "play soccer"],
    "题": [2, "tí", "question; problem"],
    "跳舞": [2, "tiào wǔ", "to dance"],
    "外": [2, "wài", "outside"],
    "完": [2, "wán", "to finish"],
    "玩": [2, "wán", "to play"],
    "晚上": [2, "wǎn shang", "evening; night"],
    "往": [2, "wǎng", "towards"],
    "为什么": [2, "wèi shén me", "why"],
    "问": [2, "wèn", "to ask"],
    "问题": [2, "wèn tí", "question; problem"],
    "西瓜": [2, "xī guā", "watermelon"],
    "希望": [2, "xī wàng", "to hope"],
    "洗": [2, "xǐ", "to wash"],
    "小时": [2, "xiǎo shí", "hour"],
    "笑": [2, "xiào", "to smile; laugh"],
    "新": [2, "xīn", "new"],
    "姓": [2, "xìng", "surname"],
    "休息": [2, "xiū xi", "to rest"],
    "雪": [2, "xuě", "snow"],
    "颜色": [2, "yán sè", "color"],
    "眼睛": [2, "yǎn jing", "eyes"],
    "羊肉": [2, "yáng ròu", "mutton"],
    "药": [2, "yào", "medicine"],
    "要": [2, "yào", "to want; will"],
    "也": [2, "yě", "also; too"],
    "一起": [2, "yī qǐ", "together"],
    "已经": [2, "yǐ jīng", "already"],
    "意思": [2, "yì si", "meaning"],
    "因为": [2, "yīn wèi", "because"],
    "所以": [2, "suǒ yǐ", "therefore"],
    "阴": [2, "yīn", "cloudy"],
    "游泳": [2, "yóu yǒng", "to swim"],
    "右边": [2, "yòu bian", "right side"],
    "鱼": [2, "yú", "fish"],
    "元": [2, "yuán", "yuan"],
    "远": [2, "yuǎn", "far"],
    "运动": [2, "yùn dòng", "exercise; sport"],
    "再": [2, "zài", "again"],
    "早上": [2, "zǎo shang", "morning"],
    "丈夫": [2, "zhàng fu", "husband"],
    "找": [2, "zhǎo", "to look for"],
    "着": [2, "zhe", "aspect particle"],
    "真": [2, "zhēn", "really; true"],
    "正在": [2, "zhèng zài", "in the middle of"],
    "知道": [2, "zhī dào", "to know"],
    "准备": [2, "zhǔn bèi", "to prepare"],
    "自行车": [2, "zì xíng chē", "bicycle"],
    "走": [2, "zǒu", "to walk"],
    "最": [2, "zuì", "most"],
    "左边": [2, "zuǒ bian", "left side"]
  },

  // IndexedDB Helper
  openDB: () => {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        return resolve(null);
      }
      const req = indexedDB.open('ChineseFlashcardDB', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('hsk_data')) {
          db.createObjectStore('hsk_data');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  },

  loadFromStorage: async () => {
    try {
      const db = await HSKManager.openDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('hsk_data', 'readonly');
        const store = tx.objectStore('hsk_data');
        const req = store.get('full_dict_3');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  },

  saveToStorage: async (dictData) => {
    try {
      const db = await HSKManager.openDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction('hsk_data', 'readwrite');
        const store = tx.objectStore('hsk_data');
        store.put(dictData, 'full_dict_3');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  },

  init: async () => {
    // 1. Seed with baseline
    for (const [w, info] of Object.entries(HSKManager.baseline)) {
      HSKManager.dict[w] = { lvl: info[0], pinyin: info[1], def: info[2] };
    }

    // 2. Check IndexedDB cache
    HSKManager.updateStatus('Loading HSK database...', 'pulsing');
    const cached = await HSKManager.loadFromStorage();
    if (cached && Object.keys(cached).length >= 1000) {
      Object.assign(HSKManager.dict, cached);
      HSKManager.isLoaded = true;
      HSKManager.updateStatus(`✓ HSK 1–7 Ready (${Object.keys(HSKManager.dict).length.toLocaleString()} words)`, 'online');
      return;
    }

    // 3. Auto-download from remote via browser JS
    await HSKManager.downloadAllLevels();
  },

  downloadAllLevels: async () => {
    if (HSKManager.isLoading) return;
    HSKManager.isLoading = true;

    HSKManager.updateStatus('Downloading HSK vocab via JS...', 'pulsing');

    let totalLoaded = 0;
    const cdnBase = 'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/new/';
    const rawBase = 'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/wordlists/exclusive/new/';

    for (let lvl = 1; lvl <= 7; lvl++) {
      HSKManager.updateStatus(`Downloading HSK Level ${lvl}/7...`, 'pulsing');
      try {
        let res = null;
        try {
          res = await fetch(`${cdnBase}${lvl}.min.json`);
        } catch (e) {
          res = await fetch(`${rawBase}${lvl}.min.json`);
        }

        if (res && res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            list.forEach(item => {
              const word = item.s;
              if (!word) return;
              const pinyin = (item.f && item.f[0] && item.f[0].i) ? (item.f[0].i.y || '') : '';
              let def = '';
              if (item.f && item.f[0] && item.f[0].m && item.f[0].m[0]) {
                def = item.f[0].m[0];
                if (def.length > 70) def = def.substring(0, 70);
              }
              HSKManager.dict[word] = { lvl, pinyin, def };
              totalLoaded++;
            });
          }
        }
      } catch (err) {
        console.warn(`Failed loading level ${lvl}`, err);
      }
    }

    HSKManager.isLoading = false;
    const wordCount = Object.keys(HSKManager.dict).length;
    if (wordCount > 500) {
      HSKManager.isLoaded = true;
      await HSKManager.saveToStorage(HSKManager.dict);
      HSKManager.updateStatus(`✓ HSK 1–7 Ready (${wordCount.toLocaleString()} words)`, 'online');
    } else {
      HSKManager.updateStatus(`● Basic HSK Ready (${wordCount} words)`, 'online');
    }
  },

  updateStatus: (msg, dotClass = '') => {
    const textEl = Utils.id('hsk-status-text');
    const dotEl = Utils.id('hsk-status-dot');
    if (textEl) textEl.innerText = msg;
    if (dotEl) {
      dotEl.className = 'status-dot ' + dotClass;
    }
  },

  syncRemote: async () => {
    Utils.showToast('🔄 Synchronizing HSK vocabulary from remote...');
    await HSKManager.downloadAllLevels();
    Utils.showToast(`✓ HSK database updated with ${Object.keys(HSKManager.dict).length.toLocaleString()} words!`);
  },

  clearCacheAndReload: async () => {
    try {
      const db = await HSKManager.openDB();
      if (db) {
        const tx = db.transaction('hsk_data', 'readwrite');
        tx.objectStore('hsk_data').clear();
      }
    } catch (e) { }
    Utils.showToast('Cache cleared. Re-fetching HSK vocabulary...');
    await HSKManager.downloadAllLevels();
  },

  getLevel: (word) => {
    const entry = HSKManager.dict[word.trim()];
    return entry ? entry.lvl : null;
  },

  // Forward Maximum Matching Word Segmentation
  segmentText: (text, options = {}) => {
    const { skipExisting = true, filterStops = false } = options;
    if (!text) return [];

    // Stop characters in Chinese (common particles/copulas)
    const stopChars = new Set(['的', '了', '是', '在', '着', '过', '吗', '呢', '吧', '啊', '得', '地']);

    // Match all contiguous Chinese runs
    const chineseBlocks = text.match(/[\u4e00-\u9fa5]+/g) || [];
    const wordCounts = new Map();
    const maxLen = 6;

    for (const block of chineseBlocks) {
      let i = 0;
      while (i < block.length) {
        let matchedWord = null;
        let matchedLen = 0;

        // Try longest matching multi-character word in HSK dict (length 6 down to 2)
        for (let len = Math.min(maxLen, block.length - i); len >= 2; len--) {
          const sub = block.slice(i, i + len);
          if (HSKManager.dict[sub]) {
            matchedWord = sub;
            matchedLen = len;
            break;
          }
        }

        if (matchedWord) {
          wordCounts.set(matchedWord, (wordCounts.get(matchedWord) || 0) + 1);
          i += matchedLen;
        } else {
          // Single character
          const ch = block[i];
          if (!filterStops || !stopChars.has(ch)) {
            wordCounts.set(ch, (wordCounts.get(ch) || 0) + 1);
          }
          i += 1;
        }
      }
    }

    // Build unique words list and cross-reference with existing cards in deck
    const existingCards = DB.getAll();
    const existingSet = new Set(existingCards.map(c => c.hanzi.trim()));

    const list = [];
    for (const [word, freq] of wordCounts.entries()) {
      const entry = HSKManager.dict[word];
      const lvl = entry ? entry.lvl : 0; // 0 represents non-HSK / Other
      const pinyin = entry ? entry.pinyin : '';
      const def = entry ? entry.def : '';
      const inDeck = existingSet.has(word);

      list.push({
        hanzi: word,
        level: lvl,
        pinyin: pinyin,
        vietnamese: '',
        english: def,
        frequency: freq,
        inDeck: inDeck,
        selected: skipExisting ? !inDeck : true
      });
    }

    return list;
  }
};

/** 6. BULK IMPORT & HSK ARRANGER CONTROLLER */
const BulkImportApp = {
  extractedWords: [],
  currentFilter: 'all',
  currentSort: 'hsk-asc',

  loadSampleText: () => {
    const sample = `北京大学是中国近代第一所国立综合性大学。今天天气非常好，我和朋友一起去超市买水果。虽然有点累，但是我们都很开心。学习汉语需要坚持和耐心，每天阅读有趣的故事，我们的词汇量就会逐渐提高。`;
    Utils.setVal('bulk-text', sample);
    Utils.showToast('📋 Loaded sample Chinese text');
  },

  clearInput: () => {
    Utils.setVal('bulk-text', '');
    BulkImportApp.extractedWords = [];
    Utils.hide(Utils.id('bulk-results-section'));
  },

  extractWords: () => {
    const text = Utils.val('bulk-text');
    if (!text) {
      alert('Please enter or paste Chinese text first.');
      return;
    }

    const skipExisting = Utils.id('opt-skip-existing') ? Utils.id('opt-skip-existing').checked : true;
    const filterStops = Utils.id('opt-filter-stops') ? Utils.id('opt-filter-stops').checked : false;

    BulkImportApp.extractedWords = HSKManager.segmentText(text, { skipExisting, filterStops });

    if (BulkImportApp.extractedWords.length === 0) {
      alert('No Chinese words could be extracted from the text.');
      return;
    }

    Utils.show(Utils.id('bulk-results-section'));
    BulkImportApp.currentFilter = 'all';
    BulkImportApp.renderSummary();
    BulkImportApp.renderLevelPills();
    BulkImportApp.renderList();

    Utils.showToast(`✨ Extracted ${BulkImportApp.extractedWords.length} unique Chinese words arranged by HSK level!`);

    // Smooth scroll down to results
    const results = Utils.id('bulk-results-section');
    if (results) results.scrollIntoView({ behavior: 'smooth' });
  },

  renderSummary: () => {
    const total = BulkImportApp.extractedWords.length;
    const newCount = BulkImportApp.extractedWords.filter(w => !w.inDeck).length;
    const selectedCount = BulkImportApp.extractedWords.filter(w => w.selected).length;

    if (Utils.id('sum-total-words')) Utils.id('sum-total-words').innerText = total;
    if (Utils.id('sum-new-words')) Utils.id('sum-new-words').innerText = newCount;
    if (Utils.id('sum-selected-words')) Utils.id('sum-selected-words').innerText = selectedCount;
    if (Utils.id('btn-selected-count')) Utils.id('btn-selected-count').innerText = selectedCount;
  },

  renderLevelPills: () => {
    const container = Utils.id('level-pills-bar');
    if (!container) return;
    container.innerHTML = '';

    // Count per level
    const counts = { all: BulkImportApp.extractedWords.length, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 0: 0 };
    BulkImportApp.extractedWords.forEach(w => {
      counts[w.level] = (counts[w.level] || 0) + 1;
    });

    const levels = [
      { id: 'all', label: 'All Levels', count: counts.all, colorClass: '' },
      { id: '1', label: 'HSK 1', count: counts[1], colorClass: 'hsk-1' },
      { id: '2', label: 'HSK 2', count: counts[2], colorClass: 'hsk-2' },
      { id: '3', label: 'HSK 3', count: counts[3], colorClass: 'hsk-3' },
      { id: '4', label: 'HSK 4', count: counts[4], colorClass: 'hsk-4' },
      { id: '5', label: 'HSK 5', count: counts[5], colorClass: 'hsk-5' },
      { id: '6', label: 'HSK 6', count: counts[6], colorClass: 'hsk-6' },
      { id: '7', label: 'HSK 7', count: counts[7], colorClass: 'hsk-7' },
      { id: '0', label: 'Other', count: counts[0], colorClass: 'hsk-0' }
    ];

    levels.forEach(lvl => {
      if (lvl.id !== 'all' && lvl.count === 0) return; // Hide empty levels
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `level-pill ${BulkImportApp.currentFilter === lvl.id ? 'active' : ''}`;
      btn.onclick = () => BulkImportApp.setFilter(lvl.id);
      btn.innerHTML = `${lvl.label} <span class="pill-count">${lvl.count}</span>`;
      container.appendChild(btn);
    });
  },

  setFilter: (lvlId) => {
    BulkImportApp.currentFilter = lvlId;
    BulkImportApp.renderLevelPills();
    BulkImportApp.renderList();
  },

  handleSortChange: (val) => {
    BulkImportApp.currentSort = val;
    BulkImportApp.renderList();
  },

  selectAll: (selectState) => {
    const filtered = BulkImportApp.getFilteredAndSortedWords();
    const filteredSet = new Set(filtered.map(w => w.hanzi));
    BulkImportApp.extractedWords.forEach(w => {
      if (filteredSet.has(w.hanzi)) {
        w.selected = selectState;
      }
    });
    BulkImportApp.renderSummary();
    BulkImportApp.renderList();
  },

  selectNewOnly: () => {
    const filtered = BulkImportApp.getFilteredAndSortedWords();
    const filteredSet = new Set(filtered.map(w => w.hanzi));
    BulkImportApp.extractedWords.forEach(w => {
      if (filteredSet.has(w.hanzi)) {
        w.selected = !w.inDeck;
      }
    });
    BulkImportApp.renderSummary();
    BulkImportApp.renderList();
  },

  toggleWord: (hanzi, checked) => {
    const item = BulkImportApp.extractedWords.find(w => w.hanzi === hanzi);
    if (item) {
      item.selected = checked;
      BulkImportApp.renderSummary();
    }
  },

  updateWordField: (hanzi, field, val) => {
    const item = BulkImportApp.extractedWords.find(w => w.hanzi === hanzi);
    if (item) {
      item[field] = val;
    }
  },

  translateSingleWord: async (hanzi) => {
    const item = BulkImportApp.extractedWords.find(w => w.hanzi === hanzi);
    if (!item) return;
    Utils.showToast(`Translating ${hanzi}...`);
    const res = await Translator.fetch(hanzi);
    if (res) {
      item.vietnamese = res.vietnamese;
      if (!item.pinyin) item.pinyin = res.pinyin;
      BulkImportApp.renderList();
      Utils.showToast(`✓ Translated: ${res.vietnamese}`);
    }
  },

  getFilteredAndSortedWords: () => {
    let list = BulkImportApp.extractedWords.slice();

    // 1. Filter by HSK Level
    if (BulkImportApp.currentFilter !== 'all') {
      const targetLvl = parseInt(BulkImportApp.currentFilter, 10);
      list = list.filter(w => w.level === targetLvl);
    }

    // 2. Sort
    list.sort((a, b) => {
      if (BulkImportApp.currentSort === 'hsk-asc') {
        const lvlA = a.level === 0 ? 99 : a.level;
        const lvlB = b.level === 0 ? 99 : b.level;
        if (lvlA !== lvlB) return lvlA - lvlB;
        return b.frequency - a.frequency;
      } else if (BulkImportApp.currentSort === 'hsk-desc') {
        const lvlA = a.level === 0 ? -1 : a.level;
        const lvlB = b.level === 0 ? -1 : b.level;
        if (lvlA !== lvlB) return lvlB - lvlA;
        return b.frequency - a.frequency;
      } else if (BulkImportApp.currentSort === 'freq-desc') {
        return b.frequency - a.frequency;
      } else if (BulkImportApp.currentSort === 'length-desc') {
        return b.hanzi.length - a.hanzi.length;
      }
      return 0;
    });

    return list;
  },

  renderList: () => {
    const container = Utils.id('extracted-words-container');
    if (!container) return;
    container.innerHTML = '';

    const list = BulkImportApp.getFilteredAndSortedWords();

    if (list.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:20px;">No words match the selected level.</p>';
      return;
    }

    list.forEach(w => {
      const card = document.createElement('div');
      card.className = `extracted-word-card ${w.inDeck ? 'in-deck' : ''}`;

      const levelLabel = w.level > 0 ? `HSK ${w.level}` : 'Other';
      const levelClass = w.level > 0 ? `hsk-${w.level}` : 'hsk-0';

      card.innerHTML = `
        <div class="card-checkbox-col">
          <input type="checkbox" id="chk-${w.hanzi}" ${w.selected ? 'checked' : ''} onchange="BulkImportApp.toggleWord('${w.hanzi}', this.checked)">
        </div>
        <div class="card-main-col">
          <div class="card-top-row">
            <div class="hanzi-wrap">
              <span class="card-word-hanzi">${w.hanzi}</span>
              <button type="button" class="btn-mini-audio" onclick="App.playWordAudio('${w.hanzi}')" title="Pronounce">🔊</button>
            </div>
            <div class="badge-group">
              <span class="badge-hsk ${levelClass}">${levelLabel}</span>
              <span class="badge-freq" title="Occurrences in text">×${w.frequency}</span>
              ${w.inDeck ? '<span class="badge-in-deck">In Deck</span>' : ''}
            </div>
          </div>
          <div class="card-fields-row">
            <input type="text" class="card-field-input" placeholder="Pinyin" value="${w.pinyin || ''}" onchange="BulkImportApp.updateWordField('${w.hanzi}', 'pinyin', this.value)">
            <div class="input-viet-wrap">
              <input type="text" class="card-field-input" placeholder="${w.english ? w.english : 'Vietnamese Meaning'}" value="${w.vietnamese || ''}" onchange="BulkImportApp.updateWordField('${w.hanzi}', 'vietnamese', this.value)">
              <button type="button" class="btn-mini-translate" onclick="BulkImportApp.translateSingleWord('${w.hanzi}')" title="Auto-translate Vietnamese">🔍</button>
            </div>
          </div>
        </div>
      `;
      container.appendChild(card);
    });
  },

  translateSelected: async () => {
    const selectedWords = BulkImportApp.extractedWords.filter(w => w.selected);
    if (selectedWords.length === 0) {
      alert('Please select at least one word to translate.');
      return;
    }

    const wordsToFetch = selectedWords.map(w => w.hanzi);
    const progContainer = Utils.id('progress-container');
    const progBar = Utils.id('progress-bar');
    const statusText = Utils.id('bulk-status');
    const btn = Utils.id('btn-batch-translate');

    btn.disabled = true;
    Utils.show(progContainer);
    if (progBar) progBar.style.width = '0%';
    if (statusText) statusText.innerText = `Translating 0 / ${wordsToFetch.length} words into Vietnamese...`;

    const translations = await Translator.fetchBatch(wordsToFetch, (done, total) => {
      const pct = Math.round((done / total) * 100);
      if (progBar) progBar.style.width = `${pct}%`;
      if (statusText) statusText.innerText = `Translating ${done} / ${total} words into Vietnamese (${pct}%)...`;
    });

    // Populate translations
    selectedWords.forEach(w => {
      if (translations[w.hanzi]) {
        w.vietnamese = translations[w.hanzi].vietnamese || w.vietnamese;
        if (!w.pinyin && translations[w.hanzi].pinyin) {
          w.pinyin = translations[w.hanzi].pinyin;
        }
      }
    });

    btn.disabled = false;
    if (progBar) progBar.style.width = '100%';
    if (statusText) statusText.innerText = `✓ Translated ${selectedWords.length} words!`;
    setTimeout(() => { Utils.hide(progContainer); if (statusText) statusText.innerText = ''; }, 2000);

    BulkImportApp.renderList();
    Utils.showToast(`✓ Completed Vietnamese translation for ${selectedWords.length} words!`);
  },

  addSelectedToFlashcards: async () => {
    const selected = BulkImportApp.extractedWords.filter(w => w.selected);
    if (selected.length === 0) {
      alert('Please select at least one word to add to your flashcards.');
      return;
    }

    const progContainer = Utils.id('progress-container');
    const progBar = Utils.id('progress-bar');
    const statusText = Utils.id('bulk-status');
    const btn = Utils.id('btn-batch-add');

    btn.disabled = true;
    Utils.show(progContainer);

    // Check if any selected card is missing Vietnamese definition; auto-translate those first
    const missingTrans = selected.filter(w => !w.vietnamese);
    if (missingTrans.length > 0) {
      if (statusText) statusText.innerText = `Auto-translating ${missingTrans.length} remaining definitions...`;
      if (progBar) progBar.style.width = '20%';
      const translations = await Translator.fetchBatch(missingTrans.map(w => w.hanzi));
      missingTrans.forEach(w => {
        if (translations[w.hanzi]) {
          w.vietnamese = translations[w.hanzi].vietnamese || w.english || 'Nghĩa';
          if (!w.pinyin) w.pinyin = translations[w.hanzi].pinyin;
        } else if (!w.vietnamese) {
          w.vietnamese = w.english || 'Nghĩa';
        }
      });
    }

    if (progBar) progBar.style.width = '60%';
    if (statusText) statusText.innerText = `Adding ${selected.length} cards to Spaced Repetition deck...`;

    // Add cards to database
    let addedCount = 0;
    selected.forEach(w => {
      const pinyinVal = w.pinyin || w.hanzi;
      const vietVal = w.vietnamese || w.english || 'Nghĩa';
      DB.add(w.hanzi, pinyinVal, vietVal, w.level);
      w.inDeck = true;
      w.selected = false; // Deselect once added
      addedCount++;
    });

    if (progBar) progBar.style.width = '100%';
    if (statusText) statusText.innerText = `🎉 Successfully imported ${addedCount} flashcards!`;

    setTimeout(() => {
      Utils.hide(progContainer);
      if (statusText) statusText.innerText = '';
      btn.disabled = false;
    }, 2500);

    // Refresh UI
    BulkImportApp.renderSummary();
    BulkImportApp.renderList();
    App.updateStats();

    Utils.showToast(`🎉 Added ${addedCount} cards to your flashcard collection!`);
  }
};

/** 7. DATA MANAGER (BACKUP & RESTORE) */
const DataMgr = {
  export: () => {
    const data = DB.getAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chinese_srs_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  },

  import: (input) => {
    const f = input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        if (Array.isArray(json) && confirm(`Import ${json.length} cards from backup?`)) {
          DB.save(json);
          alert('Backup restored successfully!');
          location.reload();
        }
      } catch (err) {
        alert('Invalid backup file');
      }
    };
    r.readAsText(f);
  },

  clear: () => {
    if (confirm('Are you sure you want to delete ALL flashcard data?')) {
      localStorage.removeItem(DB_KEY);
      location.reload();
    }
  }
};

/** 8. MAIN APP CONTROLLER */
const App = {
  dueCards: [],
  currentIdx: 0,
  activeAddTab: 'bulk',

  init: () => {
    App.setView('review');
    App.updateStats();
    // Initialize HSK manager and auto-download if needed
    HSKManager.init();
  },

  updateStats: () => {
    const cards = DB.getAll();
    const today = new Date().toISOString();
    const due = cards.filter(c => c.nextReview <= today).length;
    if (Utils.id('stat-total')) Utils.id('stat-total').innerText = cards.length;
    if (Utils.id('stat-due')) Utils.id('stat-due').innerText = due;
  },

  setView: (v) => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    if (Utils.id('nav-' + v)) Utils.id('nav-' + v).classList.add('active');

    ['review', 'add', 'list', 'settings'].forEach(id => Utils.hide(Utils.id('view-' + id)));
    Utils.show(Utils.id('view-' + v));

    if (v === 'review') App.loadSession();
    if (v === 'list') App.renderList();
    if (v === 'settings') App.updateStats();
  },

  setAddTab: (tab) => {
    App.activeAddTab = tab;
    const btnSingle = Utils.id('tab-btn-single');
    const btnBulk = Utils.id('tab-btn-bulk');
    const panelSingle = Utils.id('add-panel-single');
    const panelBulk = Utils.id('add-panel-bulk');

    if (tab === 'single') {
      if (btnSingle) btnSingle.classList.add('active');
      if (btnBulk) btnBulk.classList.remove('active');
      Utils.show(panelSingle);
      Utils.hide(panelBulk);
    } else {
      if (btnSingle) btnSingle.classList.remove('active');
      if (btnBulk) btnBulk.classList.add('active');
      Utils.hide(panelSingle);
      Utils.show(panelBulk);
    }
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
      msg.innerHTML = `<div style="font-size:3.5rem">🎉</div><h2>All Caught Up!</h2><p style="color:#64748b">No flashcards due for review.</p>`;
      return;
    }
    if (App.currentIdx >= App.dueCards.length) {
      Utils.hide(ui);
      msg.innerHTML = `<div style="font-size:3.5rem">✅</div><h2>Session Complete</h2><p style="color:#64748b">You reviewed all due cards!</p>`;
      return;
    }
    msg.innerHTML = '';
    Utils.show(ui);
    const c = App.dueCards[App.currentIdx];

    const hskBadge = Utils.id('d-hsk-badge');
    if (hskBadge) {
      const lvl = c.hsk || HSKManager.getLevel(c.hanzi);
      if (lvl) {
        hskBadge.innerText = `HSK ${lvl}`;
        hskBadge.className = `badge-hsk badge-hsk-review hsk-${lvl}`;
        Utils.show(hskBadge);
      } else {
        Utils.hide(hskBadge);
      }
    }

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
    App.updateStats();
  },

  playAudio: () => {
    const txt = Utils.id('d-hanzi').innerText;
    App.playWordAudio(txt);
  },

  playWordAudio: (word) => {
    if ('speechSynthesis' in window && word) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = 'zh-CN';
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    }
  },

  /* --- SINGLE CARD ADD --- */
  autoFill: async () => {
    const h = Utils.val('in-hanzi');
    if (!h) return;
    Utils.showToast(`Translating ${h}...`);
    const res = await Translator.fetch(h);
    if (res) {
      Utils.setVal('in-pinyin', res.pinyin);
      Utils.setVal('in-viet', res.vietnamese);
      Utils.showToast('✓ Auto-translated');
    } else {
      alert('Could not translate. Check network connection.');
    }
  },

  addCard: (e) => {
    e.preventDefault();
    const hanzi = Utils.val('in-hanzi');
    const pinyin = Utils.val('in-pinyin');
    const viet = Utils.val('in-viet');
    if (hanzi) {
      DB.add(hanzi, pinyin, viet);
      Utils.showToast(`✓ Saved "${hanzi}" to flashcards!`);
      e.target.reset();
      App.updateStats();
    }
  },

  /* --- CARDS LIST & SEARCH --- */
  renderList: () => {
    const query = Utils.val('search-input').toLowerCase();
    const cards = DB.getAll().reverse(); // Newest first
    const container = Utils.id('card-list-container');
    if (!container) return;
    container.innerHTML = '';

    // Search filter supports query string or hsk filter (e.g. hsk:2 or hsk 2)
    const hskMatch = query.match(/hsk[:\s]?([1-6])/i);
    const targetHsk = hskMatch ? parseInt(hskMatch[1], 10) : null;
    const cleanQuery = query.replace(/hsk[:\s]?[1-6]/i, '').trim();

    const filtered = cards.filter(c => {
      const matchesHsk = targetHsk === null || (c.hsk === targetHsk || HSKManager.getLevel(c.hanzi) === targetHsk);
      const matchesText = !cleanQuery ||
        c.hanzi.toLowerCase().includes(cleanQuery) ||
        c.pinyin.toLowerCase().includes(cleanQuery) ||
        c.vietnamese.toLowerCase().includes(cleanQuery);
      return matchesHsk && matchesText;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:30px;">No cards found.</p>';
      return;
    }

    filtered.forEach(c => {
      const lvl = c.hsk || HSKManager.getLevel(c.hanzi);
      const levelBadge = lvl ? `<span class="badge-hsk hsk-${lvl}">HSK ${lvl}</span>` : '';

      const div = document.createElement('div');
      div.className = 'card-item';
      div.innerHTML = `
        <div class="card-info">
          <div class="card-hanzi-row">
            <span class="card-hanzi">${c.hanzi}</span>
            ${levelBadge}
            <button type="button" class="btn-mini-audio" onclick="App.playWordAudio('${c.hanzi}')" title="Pronounce">🔊</button>
          </div>
          <div class="card-details">${c.pinyin} • ${c.vietnamese}</div>
        </div>
        <div class="card-actions">
          <button class="icon-btn btn-edit" onclick="App.openEdit('${c.id}')" title="Edit">✏️</button>
          <button class="icon-btn btn-delete" onclick="App.deleteCard('${c.id}')" title="Delete">🗑️</button>
        </div>
      `;
      container.appendChild(div);
    });
  },

  deleteCard: (id) => {
    if (confirm('Delete this card?')) {
      DB.delete(id);
      App.renderList();
      App.updateStats();
      Utils.showToast('🗑️ Card deleted');
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
      const hskSelect = Utils.id('edit-hsk');
      if (hskSelect) {
        hskSelect.value = card.hsk || '';
      }
      Utils.show(Utils.id('edit-modal'));
    }
  },

  closeModal: () => {
    Utils.hide(Utils.id('edit-modal'));
  },

  saveEdit: (e) => {
    e.preventDefault();
    const id = Utils.val('edit-id');
    const hskVal = Utils.val('edit-hsk');
    const updatedData = {
      hanzi: Utils.val('edit-hanzi'),
      pinyin: Utils.val('edit-pinyin'),
      vietnamese: Utils.val('edit-viet'),
      hsk: hskVal ? parseInt(hskVal, 10) : null
    };
    DB.update(id, updatedData);
    App.closeModal();
    App.renderList();
    Utils.showToast('✓ Card updated');
  }
};

window.onload = App.init;
