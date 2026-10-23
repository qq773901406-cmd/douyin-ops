const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const feed = field('feedUrl', 'RSS / Atom 来源', 'url', { value: 'https://www.ithome.com/rss/' });
const urls = field('urls', '来源链接，每行一个', 'lines');
const platform = field('platform', '发布草稿平台', 'select', { options: { douyin: '抖音', bilibili: 'B站' }, value: 'douyin' });
export const operationsCatalog = [
  { kind: 'workflow.news', label: '资讯采集 → 脚本 → 成片', group: '完整流程', description: '采集最新资讯、归档证据脚本、合成图卡并建立待检查的发布草稿。', fields: [feed, field('keywords', '关键词（逗号分隔）'), platform, field('enqueue', '将抖音视频加入待审批队列', 'checkbox')] },
  { kind: 'workflow.product', label: '商品资料 → 视频 → 发布准备', group: '完整流程', description: '从已保存商品资料制作字幕视频并建立发布草稿。', fields: [field('productId', '商品', 'product', { required: true }), platform, field('enqueue', '将抖音视频加入待审批队列', 'checkbox')] },
  { kind: 'content.research', label: '自动采集与研究', group: '内容运营', description: '从订阅或指定网页提取可见资料，保留来源和时间。', fields: [feed, urls, field('angle', '研究方向')] },
  { kind: 'content.ideas', label: '有来源的选题与脚本', group: '内容运营', description: '根据真实资料建立选题、来源及可编辑脚本；本地证据稿不会冒充模型创作。', fields: [feed, urls, field('audience', '目标观众'), field('angle', '表达方向')] },
  { kind: 'content.diagnosis', label: '账号数据诊断', group: '内容运营', description: '分析本工作区已有真实指标和内容资料，样本不足会明确说明。', fields: [] },
  { kind: 'content.insights', label: '效果复盘与下一轮建议', group: '内容运营', description: '按已有指标生成复盘记录和可验证的下一轮建议。', fields: [] },
  { kind: 'content.remix', label: '参考内容分析', group: '内容运营', description: '提取指定页面可见文本，形成内容结构分析，不下载或重发他人视频。', fields: [urls, field('angle', '分析目标')] },
  { kind: 'content.comments', label: '评论采集与回复草稿', group: '内容运营', description: '只读采集指定作品可见评论、分类并生成待审回复。', fields: [field('url', '抖音作品完整链接', 'url', { required: true }), field('limit', '最多采集条数', 'number', { value: 20, min: 1, max: 50 })] },
  { kind: 'content.productResearch', label: '商品研究、比价与日报', group: '商品', description: '读取指定商品页面可见资料，自动生成五份日报；未知价格与成本留空。', fields: [urls, field('downloadImages', '下载这些商品页面的公开图片用于本地制作', 'checkbox')] },
  { kind: 'media.news', label: '资讯图卡视频', group: '视频制作', description: '免费本地合成资讯图卡、静音音轨及来源说明。', fields: [feed, platform] },
  { kind: 'media.product', label: '商品图片字幕视频', group: '视频制作', description: '使用商品库里的本地图片制作竖屏视频。', fields: [field('productId', '商品', 'product', { required: true }), platform] },
  { kind: 'media.wan', label: '免费 Wan 图生视频', group: '视频制作', description: '将所选首帧交给公共免费服务生成一次视频；额度不足或结果不明会停止。', recurring: false, fields: [field('imagePath', '本机首帧图片完整路径', 'text', { required: true }), field('prompt', '镜头动作提示词', 'textarea', { required: true }), field('title', '成片标题'), field('duration', '时长（秒）', 'number', { value: 3.5, min: 0.5, max: 5, step: 0.5 }), field('seed', '随机种子', 'number', { value: 42, min: 0, max: 2147483647 }), platform] },
  { kind: 'media.edit', label: '本地视频自动拼接', group: '视频制作', description: '将已有本地镜头统一规格、拼接并检查实际成片，归档制作台。', fields: [field('clipPaths', '镜头完整路径，每行一个', 'lines', { required: true }), field('title', '成片标题', 'text', { required: true }), platform] },
  { kind: 'bilibili.track', label: 'B站审核与效果回采', group: '发布跟进', description: '只读核对已有投稿的作品编号、可见状态和指标，保存独立观察回执。', fields: [field('jobId', '投稿记录编号（留空核对所有已提交记录）')] },
  { kind: 'distribution.prepare', label: '多平台发布包', group: '发布跟进', description: '为选定草稿复制素材、文案及校验摘要，形成各平台待审批包。各平台提交需要对应账号和发布执行器。', fields: [field('draftId', '发布草稿', 'draft', { required: true }), field('platforms', '目标平台', 'platforms', { required: true })] },
  { kind: 'backup.full', label: '完整运行数据备份', group: '数据保护', description: '复制素材、工作区、发布回执和任务数据并校验摘要；变化中的文件会标记待处理。', fields: [field('backupDir', '备份父目录（留空使用项目内独立备份目录）')] },
  { kind: 'content.capture', label: '网页数据回采', group: '发布跟进', description: '执行原数据回采计划，保存指定页面真实可见数据及来源。', fields: [field('url', '抖音 HTTPS 地址', 'url', { required: true }), field('extractor', '读取内容', 'select', { options: { currentVideo: '视频公开数据', creatorMetrics: '创作者后台数据', account: '账号主页' }, value: 'currentVideo' })] },
];
