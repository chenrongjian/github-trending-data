/**
 * fetch-trending.js - 抓取 GitHub Trending 榜单并输出静态 JSON
 *
 * 抓取维度：daily / weekly / monthly × all + 11 种常用语言
 * 输出结构：data/{since}/{language}.json
 * 运行环境：GitHub Actions（Node 20），由 .github/workflows/fetch-trending.yml 每日定时触发
 *
 * 数据源：https://github.com/trending?since=daily （服务端渲染 HTML，无需登录）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SINCES = ['daily', 'weekly', 'monthly'];
const LANGS = [
  'all', 'javascript', 'python', 'go', 'rust', 'typescript',
  'java', 'c', 'c++', 'php', 'shell', 'ai'
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 请求 HTML（带重试：GitHub 偶发 5xx / 网络抖动）
function get(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  }).catch(err => {
    if (retries > 0) {
      const wait = 3000 * (3 - retries);
      console.warn(`[retry] ${url} 失败: ${err.message}，${wait / 1000}s 后重试`);
      return new Promise(r => setTimeout(r, wait)).then(() => get(url, retries - 1));
    }
    throw err;
  });
}

// 解析数量："12,345" → 12345；"1.2k" → 1200
function parseNum(text) {
  if (!text) return 0;
  const t = String(text).trim().replace(/,/g, '');
  const m = t.match(/^([\d.]+)([kKmMbB])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return 0;
  const mult = { k: 1000, m: 1000000, b: 1000000000 };
  return Math.round(n * (mult[m[2] && m[2].toLowerCase()] || 1));
}

// 解析 trending 页面的仓库列表（GitHub HTML 结构：article.Box-row）
function parseTrending(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const repos = [];

  $('article.Box-row').each((_, el) => {
    const $el = $(el);
    const href = $el.find('h2 a').first().attr('href') || '';
    const parts = href.split('/').filter(Boolean);
    if (parts.length < 2) return;

    const owner = parts[0];
    const name = parts[1];
    const fullName = `${owner}/${name}`;

    // 描述（第一个 <p>）
    let description = $el.find('p').first().text().replace(/\s+/g, ' ').trim();
    if (!description || description.length > 500) description = '';

    // 编程语言与颜色（颜色在 .repo-language-color 的 style 内联属性中）
    let language = $el.find('[itemprop="programmingLanguage"]').first().text().trim();
    let langColor = '';
    const colorEl = $el.find('.repo-language-color').first();
    if (colorEl.length) {
      const styleAttr = (colorEl.attr('style') || colorEl.attr('data-style') || '');
      const m = styleAttr.match(/background-color:\s*([^;]+)/);
      if (m) langColor = m[1].trim();
    }
    if (!langColor) {
      langColor = (colorEl.css('background-color') || '').trim();
    }

    // 总 star / fork（链接文本，形如 "12,345"）
    const stars = parseNum($el.find(`a[href="${href}/stargazers"]`).first().text());
    const forks = parseNum($el.find(`a[href="${href}/forks"]`).first().text());

    // 今日/本周/本月 star 增量（文本形如 "1,234 stars today"）
    let deltaStars = 0;
    $el.find('span').each((_, s) => {
      const t = $(s).text().trim();
      const m2 = t.match(/([\d,]+)\s+stars?\s+today|([\d,]+)\s+stars?\s+this\s+(week|month)/i);
      if (m2) {
        const raw = m2[1] || m2[2] || '0';
        deltaStars = parseInt(raw.replace(/,/g, ''), 10) || 0;
      }
    });

    repos.push({
      rank: repos.length + 1,
      owner,
      name,
      full_name: fullName,
      description,
      language: language || null,
      language_color: langColor || null,
      stars,
      forks,
      delta_stars: deltaStars,
      url: `https://github.com/${fullName}`
    });
  });

  return repos;
}

// AI 相关仓库过滤：匹配仓库名或描述中的 AI 关键字
const AI_KEYWORDS = [
  'gpt', 'llm', 'llms', 'agent', 'agents', 'chatbot', 'copilot',
  'openai', 'anthropic', 'gemini', 'llama', 'claude', 'mistral', 'deepseek',
  'machine learning', 'deep learning', 'neural network', 'transformer',
  'langchain', 'langgraph', 'diffusion', 'stable diffusion',
  'text-to-image', 'text to image', 'image generation', 'multimodal',
  'fine-tuning', 'fine tuning', 'ollama', 'vllm', 'aigc',
  'generative ai', '自然语言', '人工智能', '大模型', '智能体'
];

function filterAI(repos) {
  // 'ai' 单独匹配：要求是独立单词（前后为分隔符），避免误匹配 self-driving 等
  const aiWord = /(^|[^a-z0-9])ai([^a-z0-9]|$)/i;
  const re = new RegExp(`(^|[^a-z0-9])(${AI_KEYWORDS.join('|')})([^a-z0-9]|$)`, 'i');
  return repos.filter(r => {
    const text = `${r.full_name} ${r.description || ''}`;
    return aiWord.test(text) || re.test(text);
  });
}

async function main() {
  const now = new Date();
  const generatedAt = now.toISOString();
  let total = 0;
  let failed = 0;

  for (const since of SINCES) {
    for (const lang of LANGS) {
      // ai 是虚拟维度：抓取全量榜单后按 AI 关键字过滤
      const isAI = lang === 'ai';
      const url = (lang === 'all' || isAI)
        ? `https://github.com/trending?since=${since}`
        : `https://github.com/trending/${encodeURIComponent(lang)}?since=${since}`;
      try {
        const html = await get(url);
        let list = parseTrending(html);
        if (isAI) list = filterAI(list);
        const dir = path.join(__dirname, '..', 'data', since);
        fs.mkdirSync(dir, { recursive: true });
        const out = {
          generated_at: generatedAt,
          since,
          language: lang,
          count: list.length,
          list
        };
        fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify(out, null, 2));
        console.log(`[ok] ${since}/${lang}: ${list.length} 个仓库`);
        total += list.length;
      } catch (e) {
        failed += 1;
        console.error(`[fail] ${since}/${lang}: ${e.message}`);
      }
    }
  }

  console.log(`\n完成：共 ${total} 条数据，失败 ${failed} 项`);
  if (failed > 0 && total === 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
