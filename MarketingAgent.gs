// ============================================================
// CREATIVE ASSET AUTOPILOT — Apps Script Web App
// Qwen (Singapore intl) + Wan2.6-i2v (intl) + Drive + Human-in-the-loop
// ============================================================

// ── URLs separadas por servicio ──────────────────────────────
const QWEN_URL  = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
const TTS_URL   = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/audio/tts/synthesis';
const VIDEO_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis';
const TASK_URL  = 'https://dashscope-intl.aliyuncs.com/api/v1/tasks/';

// ============================================================
// CONFIG
// ============================================================

function getConfig() {
  const props = PropertiesService.getScriptProperties();

  const apiKey        = (props.getProperty('DASHSCOPE_API_KEY')   || '').trim().replace(/^["']|["']$/g, '');
  const videoApiKey   = (props.getProperty('DASHSCOPE_VIDEO_KEY') || '').trim().replace(/^["']|["']$/g, '');
  const approverEmail = (props.getProperty('APPROVER_EMAIL')      || '').trim();
  const driveFolderId = (props.getProperty('DRIVE_FOLDER_ID')     || '').trim();

  if (!apiKey)        throw new Error('Missing DASHSCOPE_API_KEY');
  if (!approverEmail) throw new Error('Missing APPROVER_EMAIL');

  return {
    DASHSCOPE_API_KEY:   apiKey,
    DASHSCOPE_VIDEO_KEY: videoApiKey || apiKey,
    APPROVER_EMAIL:      approverEmail,
    DRIVE_FOLDER_ID:     driveFolderId,

    QWEN_MODEL:      'qwen-plus',
    WAN_VIDEO_MODEL: 'wan2.6-i2v',
    WAN_FINAL_MODEL: 'wan2.6-i2v',
    WAN_TEXT_MODEL:  'wan2.6-t2v',

    MAX_COPY_TOKENS:    1000,
    POLL_INTERVAL_MS:   8000,
    POLL_MAX_ATTEMPTS:  45,

    PREVIEW_RESOLUTION: '720P',
    PREVIEW_DURATION:   3,
    FINAL_RESOLUTION:   '720P',
    FINAL_DURATION:     7,
  };
}

// ============================================================
// WEB APP
// ============================================================

function doGet(e) {
  e = e || {};
  const params = e.parameter || {};
  Logger.log('=== doGet HIT ===');
  Logger.log('params: ' + JSON.stringify(params));
  const cfg = getConfig();

  if (params.action === 'approve')        return handleApproval(params.id, params.folder, cfg);
  if (params.action === 'reject')         return showRevisionForm(params.id, params.folder);
  if (params.action === 'submitRevision') return handleRevisionSubmit(params, cfg);

  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('Creative Asset Autopilot')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function ping() {
  Logger.log('PING OK');
  return 'pong ' + new Date().toISOString();
}

// ============================================================
// ENTRY POINT FROM index.html
// ============================================================

function submitCampaign(payload) {
  const cfg = getConfig();

  Logger.log('===== submitCampaign HIT =====');
  Logger.log(JSON.stringify({
    businessName: payload && payload.businessName,
    product:      payload && payload.product,
    objective:    payload && payload.objective,
    audience:     payload && payload.audience,
    tone:         payload && payload.tone,
    platforms:    payload && payload.platforms,
    clientEmail:  payload && payload.clientEmail,
    detectedLang: payload && payload.detectedLang,
    hasImage:     !!(payload && (payload.imageBase64 || payload.image)),
    imageLength:  payload && (payload.imageBase64 || payload.image)
      ? String(payload.imageBase64 || payload.image).length : 0,
  }, null, 2));

  try {
    const data = normalizeWebPayload(payload);
    Logger.log('Normalized OK: ' + data.businessName);

    const root   = getRootOutputFolder(cfg);
    const folder = root.createFolder(
      safeFileName(data.businessName) + ' - ' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    );

    Logger.log('Drive folder: ' + folder.getUrl());

    data.folderId  = folder.getId();
    data.folderUrl = folder.getUrl();

    if (data.imageBase64) {
      Logger.log('Saving image...');
      const img          = saveImageToPublicFolder(data.imageBase64);
      data.imageUrl      = img.publicUrl;
      data.imageDriveUrl = img.driveUrl;
      data.imageFileId   = img.fileId;
      Logger.log('Image saved: ' + data.imageUrl);
    } else {
      Logger.log('No image received.');
    }

    Logger.log('Starting pipeline...');
    const result = processMarketingRequest(data, folder, cfg);

    Logger.log('Pipeline complete. Video: ' + (result.videoResult.previewUrl || 'pending'));

    return {
      ok:           true,
      submissionId: data.submissionId,
      folderUrl:    folder.getUrl(),
      videoUrl:     result.videoResult.previewUrl || '',
      message:      'Campaign submitted successfully.',
    };

  } catch (err) {
    Logger.log('submitCampaign ERROR: ' + err.message);
    sendErrorAlert(err, cfg);
    throw new Error(err.message);
  }
}

function normalizeWebPayload(payload) {
  payload = payload || {};
  return {
    timestamp:           new Date().toISOString(),
    businessName:        payload.businessName || 'Mi Negocio',
    product:             payload.product || payload.productService || '',
    objective:           payload.objective || payload.campaignObjective || 'increase sales',
    audience:            payload.audience || payload.targetAudience || 'general audience',
    tone:                payload.tone || payload.creativeTone || 'professional',
    platforms:           Array.isArray(payload.platforms)
                           ? payload.platforms.join(', ')
                           : (payload.platforms || 'Instagram, Facebook'),
    specialInstructions: payload.specialInstructions || payload.instructions || '',
    offerOrCta:          payload.offerOrCta || payload.cta || '',
    detectedLang:        payload.detectedLang || payload.language || 'en',
    clientEmail:         payload.clientEmail || payload.email || '',
    imageBase64:         payload.imageBase64 || payload.image || '',
    imageUrl:            payload.imageUrl || '',
    submissionId:        String(Date.now()),
  };
}

// ============================================================
// CORE PIPELINE
// ============================================================

function processMarketingRequest(data, folder, cfg) {
  saveJson(folder, 'intake.json', data);

  const copyPackage   = generateCopyPackage(data, cfg);
  copyPackage.version = 1;

  saveJson(folder, 'current-package.json', copyPackage);
  saveJson(folder, 'revision-history.json', []);

  data.voiceoverScript = copyPackage.voiceoverScript || {};

  const videoResult = generateVideoPreview(copyPackage.visualPrompt, data, cfg);
  const driveLinks  = saveArtifactsToDrive(data, copyPackage, videoResult, folder);

  sendApprovalEmail(data, copyPackage, videoResult, driveLinks, cfg);

  return { copyPackage, videoResult, driveLinks };
}

// ============================================================
// QWEN
// ============================================================

function generateCopyPackage(data, cfg) {
  const payload = {
    model: cfg.QWEN_MODEL,
    input: {
      messages: [
        {
          role: 'system',
          content:
            'You are an expert marketing strategist and bilingual copywriter. ' +
            'Return ONLY valid JSON. No markdown. No explanation. No preamble.',
        },
        {
          role: 'user',
          content: buildQwenPrompt(data),
        },
      ],
    },
    parameters: {
      max_tokens:    cfg.MAX_COPY_TOKENS,
      temperature:   0.7,
      result_format: 'message',
    },
  };

  Logger.log('Calling Qwen → ' + QWEN_URL);
  const res = dashScopePost(QWEN_URL, payload, cfg);
  Logger.log('Qwen returned OK');
  return parseQwenJson(res.output.choices[0].message.content);
}

function buildQwenPrompt(data) {
  const platforms = data.platforms || 'Instagram, Facebook';
  const platList  = platforms.split(',').map(function(p) { return p.trim().toLowerCase(); });

  const copyFields = [];
  if (platList.some(function(p) { return p.indexOf('instagram') > -1; }))
    copyFields.push('    "instagram":     { "es": "copy ES max 35 words + #hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5", "en": "copy EN max 35 words + #hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5" }');
  if (platList.some(function(p) { return p.indexOf('tiktok') > -1; }))
    copyFields.push('    "tiktok":        { "es": "copy ES max 30 words + #hashtag1 #hashtag2 #hashtag3", "en": "copy EN max 30 words + #hashtag1 #hashtag2 #hashtag3" }');
  if (platList.some(function(p) { return p.indexOf('facebook') > -1; }))
    copyFields.push('    "facebook":      { "es": "copy ES max 40 words + #hashtag1 #hashtag2 #hashtag3", "en": "copy EN max 40 words + #hashtag1 #hashtag2 #hashtag3" }');
  if (platList.some(function(p) { return p.indexOf('whatsapp') > -1; }))
    copyFields.push('    "whatsapp":      { "es": "copy ES max 30 words, no hashtags", "en": "copy EN max 30 words, no hashtags" }');
  if (platList.some(function(p) { return p.indexOf('linkedin') > -1; }))
    copyFields.push('    "linkedin":      { "es": "copy ES max 40 words, professional tone + #hashtag1 #hashtag2", "en": "copy EN max 40 words, professional tone + #hashtag1 #hashtag2" }');
  if (platList.some(function(p) { return p.indexOf('email') > -1; }))
    copyFields.push('    "email_subject": { "es": "subject ES max 8 words, no hashtags", "en": "subject EN max 8 words, no hashtags" }');

  if (copyFields.length === 0)
    copyFields.push('    "instagram": { "es": "copy ES max 35 words + #hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5", "en": "copy EN max 35 words + #hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5" }');

  const narrationLang   = data.detectedLang === 'es' ? 'Spanish' : 'English';
  const captionLang     = data.detectedLang === 'es' ? 'English' : 'Spanish';
  const captionLangCode = data.detectedLang === 'es' ? 'en' : 'es';

  return (
    'Create a complete marketing campaign package.\n\n' +
    'LANGUAGE:\n' +
    '- Browser/client language: ' + data.detectedLang + '\n' +
    '- Generate both Spanish and English copy. Prioritize the client language first.\n\n' +

    'BUSINESS BRIEF:\n' +
    '- Business: '               + data.businessName        + '\n' +
    '- Product/Service: '        + data.product             + '\n' +
    '- Objective: '              + data.objective           + '\n' +
    '- Audience: '               + data.audience            + '\n' +
    '- Tone: '                   + data.tone                + '\n' +
    '- Platforms: '              + data.platforms           + '\n' +
    '- Special Instructions: '   + data.specialInstructions + '\n' +
    '- Offer or CTA: '           + data.offerOrCta          + '\n' +
    '- Product image provided: ' + (data.imageUrl ? 'yes' : 'no') + '\n\n' +

    'VIDEO DIRECTION:\n' +
    '- visualPrompt must be in English.\n' +
    '- Create a real commercial ad, not generic stock footage.\n' +
    '- Include shot progression, camera movement, lighting, mood, product focus, and ending.\n' +
    '- If image is provided, preserve product identity and animate around it.\n' +
    '- Avoid distorted hands, extra logos, fake labels, unreadable text.\n' +
    '- Keep the prompt clean and brand-safe: no body parts, no sweat, no struggle, no weather extremes.\n' +
    '- At the END of visualPrompt, add audio direction in this exact format:\n' +
    '  "Audio: A warm confident narrator says in ' + narrationLang + ': [voiceover text max 12 words in ' + narrationLang + ']. Subtle ambient music in background."\n\n' +

    'VOICEOVER:\n' +
    '- voiceoverScript must be a single short sentence (max 15 words) spoken by a narrator.\n' +
    '- Must match the tone and objective of the campaign.\n' +
    '- Generate in both Spanish and English.\n' +
    '- voiceoverCaption is the TRANSLATION of the narrated voiceover into the OPPOSITE language.\n' +
    '- If narration is in ' + narrationLang + ', caption must be in ' + captionLang + '.\n\n' +

    'COPY RULES:\n' +
    '- You MUST generate copy for EXACTLY these platforms: ' + data.platforms + '. No more, no less.\n' +
    '- Do NOT generate copy for any platform not listed above.\n' +
    '- Max 40 words per social copy (not counting hashtags).\n' +
    '- Instagram: include 5 relevant hashtags at the end of the copy.\n' +
    '- TikTok: include 3 relevant hashtags at the end of the copy.\n' +
    '- Facebook: include 3 relevant hashtags at the end of the copy.\n' +
    '- LinkedIn: include 2 relevant professional hashtags at the end of the copy.\n' +
    '- WhatsApp and email_subject: no hashtags.\n' +
    '- Never use double quotes inside copy values — use single quotes or reword.\n' +
    '- Never use line breaks inside JSON string values.\n\n' +

    'Return ONLY this JSON:\n' +
    '{\n' +
    '  "strategy": { "es": "...", "en": "..." },\n' +
    '  "hook": { "es": "...", "en": "..." },\n' +
    '  "copies": {\n' +
    copyFields.join(',\n') + '\n' +
    '  },\n' +
    '  "visualPrompt": "[visual description]. Audio: A warm confident narrator says in ' + narrationLang + ': [voiceover ' + narrationLang + ' max 12 words]. Subtle ambient music in background.",\n' +
    '  "voiceoverScript": { "es": "max 15 words narrator sentence in Spanish", "en": "max 15 words narrator sentence in English" },\n' +
    '  "voiceoverCaption": { "narrates_in": "' + narrationLang + '", "caption_in": "' + captionLang + '", "text": "translation of the narrated voiceover in ' + captionLang + ' max 15 words" },\n' +
    '  "musicMood": "...",\n' +
    '  "cta": { "es": "...", "en": "..." },\n' +
    '  "changedFields": []\n' +
    '}'
  );
}

function parseQwenJson(rawText) {
  let clean = String(rawText || '').replace(/```json|```/g, '').trim();

  try { return JSON.parse(clean); } catch (_) {}

  clean = clean.replace(/:\s*"([\s\S]*?)"/g, function(match, val) {
    const escaped = val
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/"/g, '\\"');
    return ': "' + escaped + '"';
  });

  try { return JSON.parse(clean); } catch (_) {}

  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }

  Logger.log('=== RAW QWEN OUTPUT (broken JSON) ===');
  Logger.log(rawText.substring(0, 500));
  throw new Error('Qwen did not return valid JSON. See log for raw output.');
}

// ============================================================
// TTS — non-blocking, skips if unavailable
// ============================================================

function generateTtsAudio(text, lang, cfg) {
  try {
    const payload = {
      model: 'cosyvoice-v1',
      input: { text: text.substring(0, 200) },
      parameters: { voice: 'longxiaochun', format: 'mp3', sample_rate: 22050 },
    };
    Logger.log('Calling TTS...');
    const res      = dashScopePost(TTS_URL, payload, cfg);
    const audioUrl = (res.output && res.output.audio_url) || '';
    if (audioUrl) Logger.log('TTS audio URL: ' + audioUrl);
    else          Logger.log('TTS returned no audio_url — skipping');
    return audioUrl;
  } catch (err) {
    Logger.log('TTS failed (non-blocking): ' + err.message);
    return '';
  }
}

// ============================================================
// REVISION LOOP
// ============================================================

function revisePackageWithFeedback(intake, currentPackage, feedback, cfg) {
  const payload = {
    model: cfg.QWEN_MODEL,
    input: {
      messages: [
        {
          role: 'system',
          content:
            'You revise marketing packages. Do not recreate from scratch. ' +
            'Apply only the human feedback delta. Keep everything else consistent. ' +
            'Return ONLY valid JSON.',
        },
        {
          role: 'user',
          content:
            'ORIGINAL INTAKE:\n'   + JSON.stringify(intake, null, 2)         + '\n\n' +
            'CURRENT PACKAGE:\n'   + JSON.stringify(currentPackage, null, 2) + '\n\n' +
            'HUMAN FEEDBACK:\n'    + feedback                                + '\n\n' +
            'Return the full updated package JSON. ' +
            'Set changedFields to the exact keys changed. ' +
            'Include "visualPrompt" in changedFields if the video prompt changed.',
        },
      ],
    },
    parameters: {
      max_tokens:    cfg.MAX_COPY_TOKENS,
      temperature:   0.5,
      result_format: 'message',
    },
  };

  const res = dashScopePost(QWEN_URL, payload, cfg);
  return parseQwenJson(res.output.choices[0].message.content);
}

function showRevisionForm(submissionId, folderId) {
  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL')
                    || ScriptApp.getService().getUrl();

  const actionUrl = webAppUrl +
    '?action=submitRevision' +
    '&id=' + encodeURIComponent(submissionId) +
    '&folder=' + encodeURIComponent(folderId);

  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Request Changes</title></head>' +
    '<body style="font-family:Arial,sans-serif;background:#f6f7fb;margin:0;padding:24px;color:#111827;">' +
    '<div style="max-width:720px;margin:0 auto;background:white;border:1px solid #e5e7eb;border-radius:16px;padding:28px;">' +
    '<h1 style="margin-top:0">Request Changes</h1>' +
    '<p style="color:#6b7280">Write only what should change. The agent will apply your feedback and keep everything else.</p>' +
    '<form action="' + actionUrl + '" method="get">' +
    '<textarea name="feedback" required style="width:100%;min-height:180px;padding:14px;border:1px solid #d1d5db;border-radius:12px;font-size:15px;" ' +
    'placeholder="Example: Make the tone more premium, focus more on the product, use a darker cinematic mood."></textarea>' +
    '<br><br>' +
    '<button type="submit" style="background:#dc2626;color:white;border:none;padding:14px 22px;border-radius:10px;font-weight:bold;font-size:15px;cursor:pointer;">' +
    'Submit Revision Request</button>' +
    '</form></div></body></html>'
  );
}

function handleRevisionSubmit(params, cfg) {
  const folder         = DriveApp.getFolderById(params.folder);
  const feedback       = params.feedback || '';
  const intake         = readJson(folder, 'intake.json');
  const currentPackage = readJson(folder, 'current-package.json');
  const history        = readJson(folder, 'revision-history.json');

  const revised   = revisePackageWithFeedback(intake, currentPackage, feedback, cfg);
  revised.version = (currentPackage.version || 1) + 1;

  saveJson(folder, 'current-package.json', revised);
  saveJson(folder, 'copies.json', revised);

  history.push({
    version:   revised.version,
    status:    'REVISION_REQUESTED',
    feedback:  feedback,
    timestamp: new Date().toISOString(),
  });
  saveJson(folder, 'revision-history.json', history);

  const changed       = revised.changedFields || [];
  const needsNewVideo = changed.indexOf('visualPrompt') !== -1 || changed.indexOf('video') !== -1;

  intake.voiceoverScript = revised.voiceoverScript || {};

  const meta          = readJson(folder, 'metadata.json');
  meta.approvalStatus = 'REVISION_READY';
  meta.version        = revised.version;
  meta.lastFeedback   = feedback;
  meta.updatedAt      = new Date().toISOString();
  meta.needsNewVideo  = needsNewVideo;
  meta.revisedVisualPrompt = revised.visualPrompt || meta.visualPrompt;
  saveJson(folder, 'metadata.json', meta);

  Logger.log('Sending revision email to: ' + (intake.clientEmail || cfg.APPROVER_EMAIL));
  Logger.log('submissionId: ' + intake.submissionId);
  Logger.log('folderId: ' + folder.getId());

  sendApprovalEmail(
    intake,
    revised,
    { taskId: meta.videoTaskId, previewUrl: meta.videoUrl, status: meta.videoStatus },
    { folderUrl: folder.getUrl(), folderId: folder.getId() },
    cfg
  );

  if (needsNewVideo) {
    ScriptApp.newTrigger('regenerateVideoFromTrigger')
      .timeBased()
      .after(60 * 1000)
      .create();
  }

  return HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;text-align:center;padding:48px;">' +
    '<h2>Revision submitted</h2>' +
    '<p>Updated copies have been sent to your email.</p>' +
    (needsNewVideo ? '<p style="color:#6b7280;margin-top:8px;">A new video is being generated and will arrive in a separate email in ~3 minutes.</p>' : '') +
    '</div>'
  );
}

function regenerateVideoFromTrigger() {
  const cfg     = getConfig();
  const root    = getRootOutputFolder(cfg);
  const folders = root.getFolders();

  while (folders.hasNext()) {
    const folder = folders.next();
    try {
      const meta = readJson(folder, 'metadata.json');
      if (!meta.needsNewVideo || meta.approvalStatus !== 'REVISION_READY') continue;

      meta.needsNewVideo = false;
      saveJson(folder, 'metadata.json', meta);

      const intake           = readJson(folder, 'intake.json');
      const pkg              = readJson(folder, 'current-package.json');
      intake.voiceoverScript = pkg.voiceoverScript || {};
      intake.imageUrl        = meta.imageUrl;
      intake.detectedLang    = meta.detectedLang;

      const videoResult = generateVideoPreview(meta.revisedVisualPrompt || meta.visualPrompt, intake, cfg);

      meta.videoTaskId  = videoResult.taskId;
      meta.videoUrl     = videoResult.previewUrl;
      meta.videoStatus  = videoResult.status;
      saveJson(folder, 'metadata.json', meta);

      GmailApp.sendEmail(
        meta.clientEmail || cfg.APPROVER_EMAIL,
        'Updated Video Ready — ' + meta.businessName,
        '',
        {
          htmlBody:
            '<div style="font-family:Arial,sans-serif;padding:32px;max-width:560px;margin:0 auto;">' +
            '<h2>New video for your revision</h2>' +
            '<p><strong>' + escapeHtml(meta.businessName) + '</strong></p>' +
            (videoResult.previewUrl
              ? '<p><a href="' + videoResult.previewUrl + '" style="background:#0a0a0a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Watch Updated Video</a></p>'
              : '<p style="color:#6b7280;">Processing... Task: ' + videoResult.taskId + '</p>'
            ) +
            '</div>',
          name: 'AutoCreative Agent',
        }
      );
    } catch(_) {}
  }

  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'regenerateVideoFromTrigger') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ============================================================
// WAN VIDEO — wan2.6-i2v with audio: true
// ============================================================

function sanitizeVisualPrompt(prompt) {
  // Split at "Audio:" to preserve audio direction from Qwen
  const audioIndex = prompt.toLowerCase().indexOf('audio:');
  const visualPart = audioIndex > -1 ? prompt.substring(0, audioIndex) : prompt;
  const audioPart  = audioIndex > -1 ? prompt.substring(audioIndex) : '';

  const blocked = [
    'sweat', 'bare', 'trembling', 'struggle', 'stormy', 'mist', 'fog',
    'blood', 'pain', 'extreme', 'violent', 'gritty',
    'muscle', 'flesh', 'injury', 'suffering',
  ];

  let safe = visualPart;
  blocked.forEach(function(word) {
    const re = new RegExp('\\b' + word + '\\w*\\b', 'gi');
    safe = safe.replace(re, '');
  });
  safe = safe.replace(/\s{2,}/g, ' ').trim();

  const result = audioPart ? safe + ' ' + audioPart : safe;
  Logger.log('Sanitized prompt: ' + result);
  return result;
}

function generateVideoPreview(visualPrompt, data, cfg) {
  const safePrompt = sanitizeVisualPrompt(visualPrompt);
  Logger.log('IMAGE URL being sent to Wan: ' + (data.imageUrl || 'NONE'));
  return submitWanTask(safePrompt, data.imageUrl || null, cfg, data);
}

function submitWanTask(prompt, imageUrl, cfg, data) {
  const hasImage = !!imageUrl;
  const input    = { prompt: prompt };

  if (hasImage) {
    input.img_url = imageUrl;
  }

  const payload = {
    model:      cfg.WAN_VIDEO_MODEL,
    input:      input,
    parameters: {
      resolution:    cfg.PREVIEW_RESOLUTION,
      duration:      cfg.PREVIEW_DURATION,
      audio:         true,
      prompt_extend: true,
      shot_type:     'multi',
    },
  };

  Logger.log('Wan submit: model=' + cfg.WAN_VIDEO_MODEL + ' hasImage=' + hasImage + ' audio=true');
  const submitRes = dashScopePost(VIDEO_URL, payload, cfg);
  Logger.log('Task ID: ' + submitRes.output.task_id);
  return pollVideoTask(submitRes.output.task_id, cfg);
}

function generateHiResVideo(meta, cfg) {
  Logger.log('Calling Wan final → ' + VIDEO_URL);

  const input = { prompt: meta.visualPrompt || 'cinematic professional business promotional video. Audio: A confident narrator presents this product. Subtle ambient music.' };
  if (meta.imageUrl) input.img_url = meta.imageUrl;

  const payload = {
    model:      cfg.WAN_FINAL_MODEL,
    input:      input,
    parameters: {
      resolution:    cfg.FINAL_RESOLUTION,
      duration:      cfg.FINAL_DURATION,
      audio:         true,
      prompt_extend: true,
      shot_type:     'multi',
    },
  };

  const submitRes = dashScopePost(VIDEO_URL, payload, cfg);
  return pollVideoTask(submitRes.output.task_id, cfg);
}

function pollVideoTask(taskId, cfg) {
  for (let i = 0; i < cfg.POLL_MAX_ATTEMPTS; i++) {
    Utilities.sleep(cfg.POLL_INTERVAL_MS);
    const res    = dashScopeGet(TASK_URL + taskId, cfg);
    const status = res.output.task_status;
    Logger.log('Poll ' + (i + 1) + '/' + cfg.POLL_MAX_ATTEMPTS + ' — ' + status);

    if (status === 'SUCCEEDED') {
      return {
        taskId:     taskId,
        previewUrl: res.output.video_url ||
                    (res.output.results && res.output.results[0] && res.output.results[0].url) || '',
        status:     'ready',
      };
    }
    if (status === 'FAILED') {
      const failCode = res.output.code || '';
      if (failCode === 'DataInspectionFailed') throw new Error('IMAGE_REJECTED');
      throw new Error('Wan failed. Task: ' + taskId + ' | ' + JSON.stringify(res));
    }
  }
  return { taskId: taskId, previewUrl: '', status: 'timeout' };
}

// ============================================================
// DRIVE
// ============================================================

function getRootOutputFolder(cfg) {
  return cfg.DRIVE_FOLDER_ID
    ? DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID)
    : DriveApp.getRootFolder();
}

function saveImageToPublicFolder(imageBase64) {
  const props    = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('PUBLIC_IMAGE_FOLDER_ID');
  const folder   = DriveApp.getFolderById(folderId);

  const match = String(imageBase64).match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image format');

  const contentType = match[1];
  const base64Data  = match[2];
  const ext         = contentType.indexOf('png') !== -1 ? 'png' : 'jpg';

  const blob = Utilities.newBlob(
    Utilities.base64Decode(base64Data),
    contentType,
    'product-' + Date.now() + '.' + ext
  );

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  return {
    fileId:    fileId,
    driveUrl:  file.getUrl(),
    publicUrl: 'https://lh3.googleusercontent.com/d/' + fileId,
  };
}

function saveArtifactsToDrive(data, copyPackage, videoResult, folder) {
  saveJson(folder, 'copies.json', copyPackage);

  const meta = {
    submissionId:        data.submissionId,
    businessName:        data.businessName,
    product:             data.product,
    objective:           data.objective,
    audience:            data.audience,
    tone:                data.tone,
    platforms:           data.platforms,
    specialInstructions: data.specialInstructions,
    offerOrCta:          data.offerOrCta,
    detectedLang:        data.detectedLang,
    imageUrl:            data.imageUrl      || '',
    imageDriveUrl:       data.imageDriveUrl || '',
    imageFileId:         data.imageFileId   || '',
    clientEmail:         data.clientEmail,
    visualPrompt:        copyPackage.visualPrompt    || '',
    voiceoverScript:     copyPackage.voiceoverScript || {},
    musicMood:           copyPackage.musicMood       || '',
    videoTaskId:         videoResult.taskId,
    videoUrl:            videoResult.previewUrl,
    videoStatus:         videoResult.status,
    generatedAt:         new Date().toISOString(),
    approvalStatus:      'PENDING',
    version:             1,
  };

  saveJson(folder, 'metadata.json', meta);
  return { folderUrl: folder.getUrl(), folderId: folder.getId() };
}

function saveJson(folder, fileName, obj) {
  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    files.next().setContent(JSON.stringify(obj, null, 2));
  } else {
    folder.createFile(fileName, JSON.stringify(obj, null, 2), MimeType.PLAIN_TEXT);
  }
}

function readJson(folder, fileName) {
  return JSON.parse(getFileFromFolder(folder, fileName).getBlob().getDataAsString());
}

function getFileFromFolder(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) return files.next();
  throw new Error('File not found in Drive: ' + fileName);
}

// ============================================================
// EMAIL
// ============================================================

function sendApprovalEmail(data, copyPackage, videoResult, driveLinks, cfg) {
  const webAppUrl = ScriptApp.getService().getUrl();
  const approve   = webAppUrl + '?action=approve&id=' + encodeURIComponent(data.submissionId) + '&folder=' + encodeURIComponent(driveLinks.folderId);
  const reject    = webAppUrl + '?action=reject&id='  + encodeURIComponent(data.submissionId) + '&folder=' + encodeURIComponent(driveLinks.folderId);
  const cp        = copyPackage.copies || {};

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,sans-serif;color:#111827;">' +
    '<div style="max-width:680px;margin:0 auto;padding:32px 16px;">' +
    '<div style="background:#0a0a0a;border-radius:12px 12px 0 0;padding:28px 32px;">' +
    '<p style="margin:0;font-size:11px;font-weight:600;color:#00c98d;letter-spacing:3px;text-transform:uppercase;">AutoCreative Agent</p>' +
    '<h1 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Campaign Ready for Review</h1>' +
    '</div>' +
    '<div style="background:#ffffff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">' +

    '<div style="background:#f9fafb;border-radius:8px;padding:16px 20px;margin-bottom:24px;border-left:3px solid #00c98d;">' +
    '<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#374151;">Campaign Brief</p>' +
    '<p style="margin:4px 0;font-size:13px;color:#6b7280;"><strong style="color:#111827;">Business:</strong> '  + escapeHtml(data.businessName) + '</p>' +
    '<p style="margin:4px 0;font-size:13px;color:#6b7280;"><strong style="color:#111827;">Product:</strong> '   + escapeHtml(data.product)      + '</p>' +
    '<p style="margin:4px 0;font-size:13px;color:#6b7280;"><strong style="color:#111827;">Objective:</strong> ' + escapeHtml(data.objective)    + '</p>' +
    '<p style="margin:4px 0;font-size:13px;color:#6b7280;"><strong style="color:#111827;">Audience:</strong> '  + escapeHtml(data.audience)     + '</p>' +
    '<p style="margin:4px 0;font-size:13px;color:#6b7280;"><strong style="color:#111827;">Tone:</strong> '      + escapeHtml(data.tone)         + '</p>' +
    '</div>' +

    '<h2 style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px;border-bottom:1px solid #f3f4f6;padding-bottom:6px;">Strategy</h2>' +
    '<p style="margin:0 0 4px;font-size:13px;color:#374151;"><strong>ES:</strong> ' + escapeHtml((copyPackage.strategy || {}).es || '') + '</p>' +
    '<p style="margin:0 0 20px;font-size:13px;color:#374151;"><strong>EN:</strong> ' + escapeHtml((copyPackage.strategy || {}).en || '') + '</p>' +

    '<h2 style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px;border-bottom:1px solid #f3f4f6;padding-bottom:6px;">Hook</h2>' +
    '<p style="margin:0 0 4px;font-size:13px;color:#374151;"><strong>ES:</strong> ' + escapeHtml((copyPackage.hook || {}).es || '') + '</p>' +
    '<p style="margin:0 0 20px;font-size:13px;color:#374151;"><strong>EN:</strong> ' + escapeHtml((copyPackage.hook || {}).en || '') + '</p>' +

    '<h2 style="font-size:15px;font-weight:700;color:#111827;margin:0 0 12px;border-bottom:1px solid #f3f4f6;padding-bottom:6px;">Platform Copy</h2>' +
    '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:24px;">' +
    '<tr style="background:#f9fafb;">' +
    '<th style="padding:10px 12px;text-align:left;border:1px solid #e5e7eb;font-weight:600;color:#374151;width:18%;">Channel</th>' +
    '<th style="padding:10px 12px;text-align:left;border:1px solid #e5e7eb;font-weight:600;color:#374151;">Spanish</th>' +
    '<th style="padding:10px 12px;text-align:left;border:1px solid #e5e7eb;font-weight:600;color:#374151;">English</th>' +
    '</tr>' +
    [
      ['Instagram',     cp.instagram],
      ['TikTok',        cp.tiktok],
      ['Facebook',      cp.facebook],
      ['WhatsApp',      cp.whatsapp],
      ['LinkedIn',      cp.linkedin],
      ['Email Subject', cp.email_subject],
    ].filter(function(r) { return r[1] && (r[1].es || r[1].en); })
     .map(function(r)   { return buildCopyRow(r[0], r[1]); })
     .join('') +
    '</table>' +

    '<h2 style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px;border-bottom:1px solid #f3f4f6;padding-bottom:6px;">Voiceover Script</h2>' +
    '<p style="margin:0 0 4px;font-size:13px;color:#374151;"><strong>ES:</strong> ' + escapeHtml((copyPackage.voiceoverScript || {}).es || '') + '</p>' +
    '<p style="margin:0 0 20px;font-size:13px;color:#374151;"><strong>EN:</strong> ' + escapeHtml((copyPackage.voiceoverScript || {}).en || '') + '</p>' +

    '<h2 style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px;border-bottom:1px solid #f3f4f6;padding-bottom:6px;">Video Preview</h2>' +
    (videoResult.previewUrl
      ? '<p style="margin:0 0 20px;"><a href="' + videoResult.previewUrl + '" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">Watch Video Preview</a></p>'
      : '<p style="margin:0 0 20px;font-size:13px;color:#6b7280;">Video processing — Task ID: ' + escapeHtml(videoResult.taskId) + '</p>'
    ) +

    '<p style="margin:0 0 28px;font-size:13px;"><a href="' + driveLinks.folderUrl + '" style="color:#2563eb;font-weight:600;">View all assets in Drive</a></p>' +

    '<div style="background:#f9fafb;border-radius:10px;padding:24px;border:1px solid #e5e7eb;">' +
    '<p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#111827;">Your Decision</p>' +
    '<p style="margin:0 0 16px;font-size:13px;color:#6b7280;">Happy with the campaign? Approve to generate the final video. Need changes? Request a revision.</p>' +
    '<a href="' + approve + '" style="display:inline-block;background:#16a34a;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;margin-right:10px;">Approve</a>' +
    '<a href="' + reject  + '" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Request Changes</a>' +
    '</div>' +

    '<p style="margin:24px 0 0;font-size:11px;color:#9ca3af;text-align:center;">Campaign ID: ' + escapeHtml(data.submissionId) + '</p>' +
    '</div></div></body></html>';

  GmailApp.sendEmail(
    data.clientEmail || cfg.APPROVER_EMAIL,
    'Campaign Ready for Review — ' + data.businessName,
    '',
    { htmlBody: html, name: 'AutoCreative Agent' }
  );

  Logger.log('Approval email sent to: ' + (data.clientEmail || cfg.APPROVER_EMAIL));
}

function buildCopyRow(label, value) {
  value = value || {};
  return (
    '<tr>' +
    '<td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:600;color:#374151;vertical-align:top;">' + escapeHtml(label)           + '</td>' +
    '<td style="padding:10px 12px;border:1px solid #e5e7eb;color:#374151;vertical-align:top;">'                 + escapeHtml(value.es || '') + '</td>' +
    '<td style="padding:10px 12px;border:1px solid #e5e7eb;color:#374151;vertical-align:top;">'                 + escapeHtml(value.en || '') + '</td>' +
    '</tr>'
  );
}

// ============================================================
// APPROVAL
// ============================================================

function handleApproval(submissionId, folderId, cfg) {
  const folder = DriveApp.getFolderById(folderId);
  const meta   = readJson(folder, 'metadata.json');

  meta.approvalStatus = 'APPROVED';
  meta.approvedAt     = new Date().toISOString();

  const hiRes = generateHiResVideo(meta, cfg);

  meta.finalVideoTaskId = hiRes.taskId;
  meta.finalVideoUrl    = hiRes.previewUrl;
  meta.finalVideoStatus = hiRes.status;
  saveJson(folder, 'metadata.json', meta);

  GmailApp.sendEmail(
    meta.clientEmail || cfg.APPROVER_EMAIL,
    'Final Video Ready — ' + meta.businessName,
    '',
    {
      htmlBody:
        '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
        '<body style="font-family:Arial,sans-serif;background:#f4f4f7;margin:0;padding:32px 16px;">' +
        '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;text-align:center;">' +
        '<div style="width:48px;height:48px;background:#dcfce7;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">' +
        '<span style="font-size:24px;color:#16a34a;">&#10003;</span></div>' +
        '<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Campaign Approved</h2>' +
        '<p style="color:#6b7280;font-size:14px;margin:0 0 20px;">Final video is ready.</p>' +
        '<p style="font-weight:700;margin-bottom:16px;">' + escapeHtml(meta.businessName) + '</p>' +
        (hiRes.previewUrl
          ? '<a href="' + hiRes.previewUrl + '" style="background:#0a0a0a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Download Final Video</a>'
          : '<p style="color:#6b7280;">Processing... Task: ' + escapeHtml(hiRes.taskId) + '</p>'
        ) +
        '<br><br><a href="' + folder.getUrl() + '" style="color:#2563eb;font-size:13px;">View Drive folder</a>' +
        '</div></body></html>',
      name: 'AutoCreative Agent',
    }
  );

  return HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;text-align:center;padding:48px;">' +
    '<h2>Approved!</h2>' +
    '<p>Final video is being generated. You will receive an email when it is ready.</p>' +
    '</div>'
  );
}

// ============================================================
// HTTP HELPERS
// ============================================================

function dashScopePost(url, payload, cfg) {
  const apiKey = url.indexOf('/video-generation/') !== -1
    ? cfg.DASHSCOPE_VIDEO_KEY
    : cfg.DASHSCOPE_API_KEY;

  const headers = { 'Authorization': 'Bearer ' + apiKey };

  if (url.indexOf('/video-generation/') !== -1) {
    headers['X-DashScope-Async'] = 'enable';
  }

  Logger.log('POST → ' + url + ' | model: ' + (payload ? payload.model : 'none'));

  const res  = UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    headers:            headers,
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (!text || text.trim() === '') {
    throw new Error('DashScope returned empty response. HTTP ' + code);
  }

  let body;
  try   { body = JSON.parse(text); }
  catch (_) { throw new Error('DashScope returned non-JSON. HTTP ' + code + ': ' + text); }

  if (code < 200 || code >= 300) throw new Error('DashScope ' + code + ': ' + text);
  return body;
}

function dashScopeGet(url, cfg) {
  const apiKey = url.indexOf('/tasks/') !== -1
    ? cfg.DASHSCOPE_VIDEO_KEY
    : cfg.DASHSCOPE_API_KEY;

  const res  = UrlFetchApp.fetch(url, {
    method:             'get',
    headers:            { 'Authorization': 'Bearer ' + apiKey },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  let body;
  try   { body = JSON.parse(text); }
  catch (_) { throw new Error('DashScope GET non-JSON. HTTP ' + code + ': ' + text); }

  if (code < 200 || code >= 300) throw new Error('DashScope GET ' + code + ': ' + text);
  return body;
}

// ============================================================
// UTILS
// ============================================================

function safeFileName(value) {
  return String(value || 'campaign').replace(/[\\/:*?"<>|]/g, '-').substring(0, 80);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

function sendErrorAlert(err, cfg) {
  if (!cfg || !cfg.APPROVER_EMAIL) return;
  GmailApp.sendEmail(
    cfg.APPROVER_EMAIL,
    '[Error] Marketing pipeline failed',
    'Error: ' + err.message + '\n\nStack: ' + err.stack
  );
}
