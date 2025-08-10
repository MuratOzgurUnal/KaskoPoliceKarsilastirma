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
const AI_MODEL = "gpt-4o-mini"; // "gpt-3.5-turbo" yerine daha yetenekli ve uygun fiyatlı yeni model

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
  let policyBlocks = '';
  policies.forEach((p, i) => {
    policyBlocks += `
--- START OF POLICY #${i + 1} (File: ${fileNames[i]}) ---
${p}
--- END OF POLICY #${i + 1} ---\n\n`;
  });

  const prompt = `
# GÖREV: KASKO POLİÇESİ KARŞILAŞTIRMA — TARAFSIZ SÜRÜM

Sen, **tamamen tarafsız, adil ve objektif** çalışan bir kasko sigortası analiz sistemisin. Sana verilen poliçe metinlerini analiz ederek **yalnızca metindeki verilere dayan** ve **önyargısız** bir karşılaştırma üret. Yorumlarda marka/şirket ismi ayrımcılığı yapma; **güçlü ve zayıf yönleri somut verilerle belirt.** Çıktın **SADECE JSON** olmalıdır.

## JSON ÇIKIŞ ŞEMASI (ZORUNLU)
{
  "aiCommentary": "HTML formatında KISA uzman analizi ve tavsiye",
  "tableHtml": "HTML formatında DETAYLI karşılaştırma tablosu"
}

## ZORUNLU KURALLAR
- **Tarafsızlık:** Her zaman dengeli, veri odaklı yaz. Reklam/pazarlama dili kullanma.
- **Kısa ve net ol:** Uzman Analizi bölümünü kısa tut (maks. 6–8 madde + 1 kısa sonuç cümlesi).
- **Şirket adları:** “Poliçe 1/2” deme. Metinden tespit ettiğin **gerçek sigorta şirketi adlarını** kullan.
- **Varsayım yapma:** Belgede yer almayan bilgiye hüküm verme. Bilinmiyorsa “Belirtilmemiş” yaz.
- **Biçim:** Sadece istenen HTML yapılarını kullan; inline stil mecbur olmadıkça kullanma.

## BÖLÜM A — Uzman Analizi ve Tavsiye (aiCommentary - HTML)
Aşağıdaki başlık ve yapı **zorunlu**:

<h4>Uzman Analizi ve Tavsiye</h4>
<ul>
  <!-- İki poliçenin birbirinden ayrıştığı net noktalar -->
  <li><strong>[Şirket Adı 1]</strong> — Bu poliçenin güçlü yönlerinden 1–2 somut madde.</li>
  <li><strong>[Şirket Adı 2]</strong> — Bu poliçenin güçlü yönlerinden 1–2 somut madde.</li>
  <!-- Ayrışma maddeleri -->
  <li>Fark 1: [Kapsam/limit/koşul] bakımından iki poliçe arasındaki net fark.</li>
  <li>Fark 2: [Kapsam/limit/koşul] bakımından iki poliçe arasındaki net fark.</li>
  <li>Fark 3: [varsa] kısa ve ölçülebilir bir fark daha.</li>
</ul>
<p><em>Kısa Sonuç:</em> Kullanım senaryosuna göre tercih önerini tek cümlede, tarafsız bir dille yaz (ör. “Şehir içi yoğun kullanım ve düşük bütçe için X; yüksek İMM ve ikame araç önceliği için Y daha uygundur.”).</p>

## BÖLÜM B — Detaylı Karşılaştırma Tablosu (tableHtml - HTML)
Tabloda **tüm kapsam ve limitleri** eksiksiz listele. Her satır: **Kapsam/Limit adı** + **Şirket 1 değeri** + **Şirket 2 değeri**.

TABLO İSKELETİ (zorunlu):
\`\`\`html
<thead>
  <tr>
    <th>Kapsam / Limit / Özellik</th>
    <th>[Şirket Adı 1]</th>
    <th>[Şirket Adı 2]</th>
  </tr>
</thead>
<tbody>
  <!-- Her kapsam/limit için satır -->
  <tr>
    <td>Poliçe Türü</td>
    <td>[Değer 1]</td>
    <td>[Değer 2]</td>
  </tr>
  <!-- ... tüm kalemler ... -->
</tbody>
\`\`\`

**Asgari kontrol listesi (tamamını ekle, metinde olan diğer kalemleri de dahil et):**
- Poliçe Türü
- Yıllık Prim Tutarı
- Kasko Araç Değeri / Sigorta Bedeli
- İhtiyari Mali Mesuliyet (İMM)
- Koltuk Ferdi Kaza (Ölüm/Sakatlık)
- Hukuksal Koruma
- İkame Araç (gün)
- Asistans (çekici vb.)
- Cam
- Mini Onarım
- Deprem & Doğal Afet
- Sel / Su Baskını
- Terör
- Anahtar Kaybı/Çalınması
- Yanlış Akaryakıt Dolumu
- Kişisel Eşya
- Hayvanların Vereceği Zararlar
- Hasar Muafiyeti / Muafiyet Koşulları
- Poliçelerde bulunan **diğer tüm** özel kloz/limit/istisnalar

# ANALİZ EDİLECEK METİNLER
${policyBlocks}
`;
  return prompt;
}

function generateTestResponse(policies, fileNames) {
  let tableHeader = '<th>Kapsam / Özellik</th>';
  let tableBody = `<tr><td>Dosya Adı</td>`;

  fileNames.forEach((name) => {
    tableHeader += `<th>${name}</th>`;
    tableBody += `<td>${name}</td>`;
  });
  tableBody += '</tr>';

  return {
    aiCommentary: `
      <h4>Uzman Analizi ve Tavsiye</h4>
      <ul>
        <li><strong>${fileNames[0] || 'Poliçe A'}</strong> — Test modunda örnek güçlü yön.</li>
        ${fileNames[1] ? `<li><strong>${fileNames[1]}</strong> — Test modunda örnek güçlü yön.</li>` : ''}
        <li>Fark 1: (Test) Örnek bir ayrışma noktası.</li>
        <li>Fark 2: (Test) Örnek bir ayrışma noktası.</li>
      </ul>
      <p><em>Kısa Sonuç:</em> Bu bir test yanıtıdır. Gerçek analiz için API anahtarınızı ekleyin.</p>
    `,
    tableHtml: `
      <thead><tr>${tableHeader}</tr></thead>
      <tbody>
        ${tableBody}
        <tr><td>Durum</td>${policies.map(()=>'<td>✓ Yüklendi</td>').join('')}</tr>
        <tr><td>Metin Uzunluğu</td>${policies.map(p=>`<td>${p.length} karakter</td>`).join('')}</tr>
      </tbody>
    `
  };
}


module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};