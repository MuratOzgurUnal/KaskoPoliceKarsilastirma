// api/analyze.js - Vercel Serverless Function (SON GÜNCEL VERSİYON)
const { formidable } = require('formidable'); // <<< DÜZELTME BURADA
const fs = require('fs').promises;
const pdf = require('pdf-parse');
const OpenAI = require('openai');

// OpenAI client'ı
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ayarlar
const MAX_TEXT_LENGTH = 15000; // API token limitini aşmamak için karakter limiti
const AI_MODEL = "gpt-4o"; // "gpt-3.5-turbo" yerine daha yetenekli ve uygun fiyatlı yeni model

// Ana handler fonksiyonu
async function handler(req, res) {
  // CORS ayarları (Vercel için standart)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Sadece POST metotlarını kabul et
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Only POST requests are accepted.' });
  }

  try {
    const { policyTexts, uploadedFileNames } = await parseAndExtractPdfTexts(req);

    if (policyTexts.length < 2) {
      return res.status(400).json({ error: 'En az 2 geçerli ve okunabilir PDF dosyası gereklidir.' });
    }
    
    // DEBUG Modu: OPENAI_API_KEY yoksa test verisi döndür
    if (!process.env.OPENAI_API_KEY) {
      console.log('Running in test mode (no OpenAI API key)');
      const testResponse = generateTestResponse(policyTexts, uploadedFileNames);
      return res.status(200).json(testResponse);
    }
    
    // OpenAI için prompt oluştur
    const prompt = createComparisonPrompt(policyTexts, uploadedFileNames);
    
    console.log('Calling OpenAI API with a new powerful prompt...');
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'Sen Türkiye kasko sigortaları konusunda uzman bir analiz danışmanısın. Cevapların her zaman istenen JSON formatında olmalı. HTML kullanırken temiz ve basit etiketler kullan.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2, // Daha tutarlı ve analitik cevaplar için
      max_tokens: 3000, // Daha uzun ve detaylı cevaplara izin ver
      response_format: { type: "json_object" }, // JSON çıktısını garanti eder
    });

    const content = completion.choices[0].message.content;
    console.log('API Response received.');

    // JSON'u parse et ve doğrula
    let result;
    try {
      result = JSON.parse(content);
      if (typeof result !== 'object' || !result.aiCommentary || !result.tableHtml) {
        throw new Error('Invalid JSON structure from AI');
      }
    } catch (e) {
      console.error('JSON Parse Error:', e.message);
      throw new Error('AI tarafından geçersiz formatta yanıt alındı.');
    }
    
    console.log('Returning successful analysis.');
    return res.status(200).json(result);

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message || 'Analiz sırasında sunucuda bir hata oluştu.' });
  }
}

async function parseAndExtractPdfTexts(req) {
  const form = formidable({ // Bu satır artık doğru çalışacak
    uploadDir: '/tmp',
    keepExtensions: true,
    maxFileSize: 50 * 1024 * 1024,
    multiples: true
  });

  const [fields, files] = await form.parse(req);
  const uploadedFiles = Array.isArray(files.files) ? files.files : [files.files || []];
  
  if (uploadedFiles.length === 0) {
      throw new Error('Dosya yüklenmedi.');
  }

  const policyTexts = [];
  const uploadedFileNames = [];

  for (const file of uploadedFiles) {
    const filePath = file.filepath;
    try {
      const dataBuffer = await fs.readFile(filePath);
      const pdfData = await pdf(dataBuffer);
      const text = pdfData.text ? pdfData.text.trim() : '';

      if (text.length > 100) { // Sadece anlamlı metin içerenleri al
        policyTexts.push(text.substring(0, MAX_TEXT_LENGTH));
        uploadedFileNames.push(file.originalFilename || `Poliçe ${policyTexts.length}`);
      }
    } catch (error) {
      console.error(`Error processing file ${file.originalFilename}:`, error.message);
    } finally {
      // Geçici dosyayı sil
      await fs.unlink(filePath).catch(e => console.error(`Failed to delete temp file ${filePath}:`, e));
    }
  }

  return { policyTexts, uploadedFileNames };
}

function createComparisonPrompt(policies, fileNames) {
  // Allianz poliçesinin hangi index'te olduğunu bul
  let allianzPolicyIndex = -1;
  const allianzKeywords = ['allianz', 'allianz sigorta'];
  policies.forEach((p, i) => {
    const lowerCasePolicy = p.toLowerCase();
    if (allianzKeywords.some(keyword => lowerCasePolicy.includes(keyword))) {
      allianzPolicyIndex = i;
    }
  });

  // Poliçe metinlerini bloklar halinde hazırla
  let policyBlocks = '';
  policies.forEach((p, i) => {
    policyBlocks += `
--- POLIÇE ${i + 1} (${fileNames[i]}) ---
${p}
--- END OF POLIÇE ${i + 1} ---\n\n`;
  });

  // TEMEL TALİMATLAR - BU KISIM DEĞİŞMİYOR
  const baseInstructions = `
Sen Türkiye kasko sigortaları konusunda uzman bir analiz danışmanısın. Cevabını BANA SADECE ve HER ZAMAN aşağıdaki JSON formatında ver:
{
  "aiCommentary": "HTML formatında, yapay zeka tarafından oluşturulmuş dinamik uzman yorumu.",
  "tableHtml": "HTML formatında, <thead> ve <tbody> içeren, tüm teminatları karşılaştıran EKSİKSİZ bir tablo."
}
`;

  // ALLIANZ VARSA EKLENECEK MUTLAK VE NET TALİMATLAR
  const allianzInstructions = `
ÖZEL TALİMAT: ALLIANZ POLİÇESİ (Poliçe ${allianzPolicyIndex + 1}) TESPİT EDİLDİ.
Aşağıdaki iki görevi, verdiğim kurallara harfiyen uyarak yerine getirmek ZORUNDASIN.

---
**GÖREV 1: EKSİKSİZ KARŞILAŞTIRMA TABLOSU (\`tableHtml\`)**

1.  **HİÇBİR ŞEYİ ATMA:** İki poliçede adı geçen BÜTÜN teminatları, limitleri, hizmetleri ve muafiyetleri tabloya ekle. Tablo EKSİKSİZ olacak. Bir poliçede olup diğerinde olmayan bir özellik varsa bile tabloya ekle ve diğer poliçenin hücresine 'Yok' veya 'Belirtilmemiş' yaz. Bu, en önemli kuraldır.
2.  **VURGULA:** Avantajlı değerleri yeşil renkle (\`<strong style="color: #10B981;">...</strong>\`) vurgula.
3.  **TAVSİYE EKLE:** Tabloda Allianz sütun başlığını "Poliçe ${allianzPolicyIndex + 1} - Allianz (Tavsiye Edilen)" olarak değiştir.

---
**GÖREV 2: ALLIANZ AVANTAJ YORUMU (\`aiCommentary\`)**

1.  **SADECE AVANTAJLARI SEÇ:** Sadece ve sadece Allianz'ın diğer poliçeye göre **kanıtlanabilir şekilde daha üstün** olduğu (daha yüksek limit, rakipte olmayan teminat, daha iyi şartlar gibi) konuları seç. Eğer İMM limiti daha düşükse, o konudan ASLA BAHSETME. Bu kural mutlaktır.
2.  **DERİNLEMESİNE YORUMLA:** Seçtiğin HER BİR AVANTAJ için, aşağıdaki örnekte gösterilen formatı ve derinliği KULLANARAK, kendi özgün yorumunu oluştur. Her avantajı ayrı bir paragraf veya başlık altında ele al.

    **ÖRNEK "YENİ DEĞER TEMİNATI" YORUMU (BU FORMATI VE DETAYI TAKLİT ET):**
    "<h4>🏆 Neden Allianz Poliçesi Öne Çıkıyor? İşte Avantajları</h4>
    <p><strong>‘Yeni Değer’ Teminatı: Sıfır Aracınız Tam Güvencede</strong></p>
    <p>‘Yeni Değer’ teminatı, özellikle sıfır kilometre araç sahipleri için en kritik güvencelerden biridir ve Allianz poliçesinde bu teminatın bulunması, onu diğer poliçeden ayıran en büyük avantajdır.</p>
    <ul>
        <li><strong>Anlamı Nedir?:</strong> Aracın ilk tescilinden sonraki bir yıl içinde tam hasara (pert) uğraması durumunda, sigorta şirketi aracın ikinci el piyasa değerini (rayiç bedel) değil, hasar tarihindeki anahtar teslim <strong>sıfır satış bedelini</strong> öder.</li>
        <li><strong>Pratikteki Farkı Nedir?:</strong> Standart poliçeler genellikle rayiç bedel üzerinden ödeme yapar. Yeni bir araç trafiğe çıktığı an değer kaybeder ve rayiç bedeli, fatura bedelinden kolayca %10-20 daha düşük olabilir.</li>
        <li><strong>Size Somut Faydası:</strong> Bu teminat sayesinde, pert durumunda cebinizden ek para çıkmadan <strong>aynı aracın sıfırını tekrar satın alabilirsiniz.</strong> Bu, sizi büyük bir finansal kayıptan tamamen korur.</li>
    </ul>"

3.  **DİĞER AVANTAJLARI DA AYNI ŞEKİLDE AÇIKLA:** Poliçede bulduğun, gerçekten avantajlı olan diğer tüm konuları (örneğin yüksek Manevi Tazminat, rakipte olmayan Kemirgen Hasarı vb.) yukarıdaki örnekteki gibi **aynı derinlikte ve yapıda** açıkla. Yorumların kısa ve yüzeysel olmayacak.
---
`;

  // EĞER ALLIANZ YOKSA uygulanacak genel yorum talimatı
  const noAllianzInstructions = `
TALİMAT: ALLIANZ TESPİT EDİLMEDİ.
İki poliçeyi karşılaştıran eksiksiz bir tablo (\`tableHtml\`) oluştur. 'aiCommentary' bölümünde ise, tablodaki verilere dayanarak her iki poliçenin de güçlü ve zayıf yönlerini özetleyen dengeli ve tarafsız bir karşılaştırma yap.
`;

  // Doğru talimat setini seç
  const finalInstructions = allianzPolicyIndex !== -1 ? allianzInstructions : noAllianzInstructions;

  // Final prompt'u oluştur
  const finalPrompt = baseInstructions + finalInstructions + `\n\nAnalizini aşağıdaki poliçe metinlerine göre yap:\n${policyBlocks}`;

  return finalPrompt;
}


module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
