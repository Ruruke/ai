import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import Message from '@/message.js';
import config from '@/config.js';
import Friend from '@/friend.js';
import urlToBase64 from '@/utils/url2base64.js';
import urlToJson from '@/utils/url2json.js';
import got from 'got';
import loki from 'lokijs';

type AiChat = {
  question: string;
  prompt: string;
  api: string;
  key: string;
  fromMention: boolean;
  friendName?: string;
  grounding?: boolean;
  history?: { role: string; content: string }[];
};
type base64File = {
  type: string;
  base64: string;
  url?: string;
};
type GeminiOptions = {
  contents?: GeminiContents[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: [{}];
};
type GeminiParts = {
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  text?: string;
}[];
type GeminiSystemInstruction = {
  role: string;
  parts: [{ text: string }];
};
type GeminiContents = {
  role: string;
  parts: GeminiParts;
};

type AiChatHist = {
  postId: string;
  createdAt: number;
  type: string;
  api?: string;
  history?: {
    role: string;
    content: string;
  }[];
  friendName?: string;
  originalNoteId?: string;
  fromMention: boolean;
  grounding?: boolean;
};

type UrlPreview = {
  title: string;
  icon: string;
  description: string;
  thumbnail: string;
  player: {
    url: string;
    width: number;
    height: number;
    allow: [];
  };
  sitename: string;
  sensitive: boolean;
  activityPub: string;
  url: string;
};

const TYPE_GEMINI = 'gemini';
const geminiModel = config.geminiModel || 'gemini-2.0-flash-exp';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
const GROUNDING_TARGET = 'ggg';

const RANDOMTALK_DEFAULT_PROBABILITY = 0.02; // デフォルトのrandomTalk確率
const TIMEOUT_TIME = 1000 * 60 * 60 * 0.5; // aichatの返信を監視する時間
const RANDOMTALK_DEFAULT_INTERVAL = 1000 * 60 * 60 * 12; // デフォルトのrandomTalk間隔

const AUTO_NOTE_DEFAULT_INTERVAL = 1000 * 60 * 360;
const AUTO_NOTE_DEFAULT_PROBABILITY = 0.02;

export default class extends Module {
  public readonly name = 'aichat';
  private aichatHist: loki.Collection<AiChatHist>;
  private randomTalkProbability: number = RANDOMTALK_DEFAULT_PROBABILITY;
  private randomTalkIntervalMinutes: number = RANDOMTALK_DEFAULT_INTERVAL;

  @bindThis
  public install() {
    this.aichatHist = this.ai.getCollection('aichatHist', {
      indices: ['postId', 'originalNoteId'],
    });

    if (
      config.aichatRandomTalkProbability != undefined &&
      !Number.isNaN(Number.parseFloat(config.aichatRandomTalkProbability))
    ) {
      this.randomTalkProbability = Number.parseFloat(
        config.aichatRandomTalkProbability
      );
    }
    if (
      config.aichatRandomTalkIntervalMinutes != undefined &&
      !Number.isNaN(Number.parseInt(config.aichatRandomTalkIntervalMinutes))
    ) {
      this.randomTalkIntervalMinutes =
        1000 * 60 * Number.parseInt(config.aichatRandomTalkIntervalMinutes);
    }
    this.log('aichatRandomTalkEnabled:' + config.aichatRandomTalkEnabled);
    this.log('randomTalkProbability:' + this.randomTalkProbability);
    this.log(
      'randomTalkIntervalMinutes:' +
        this.randomTalkIntervalMinutes / (60 * 1000)
    );
    this.log(
      'aichatGroundingWithGoogleSearchAlwaysEnabled:' +
        config.aichatGroundingWithGoogleSearchAlwaysEnabled
    );

    if (config.aichatRandomTalkEnabled) {
      setInterval(this.aichatRandomTalk, this.randomTalkIntervalMinutes);
    }

    // ここで geminiPostMode が "auto" もしくは "both" の場合、自動ノート投稿を設定
    if (config.geminiPostMode === 'auto' || config.geminiPostMode === 'both') {
      const interval =
        config.autoNoteIntervalMinutes &&
        !isNaN(parseInt(config.autoNoteIntervalMinutes))
          ? 1000 * 60 * parseInt(config.autoNoteIntervalMinutes)
          : AUTO_NOTE_DEFAULT_INTERVAL;
      setInterval(this.autoNote, interval);
      this.log('Gemini自動ノート投稿を有効化: interval=' + interval);
      const probability =
        config.geminiAutoNoteProbability &&
        !isNaN(parseFloat(config.geminiAutoNoteProbability))
          ? parseFloat(config.geminiAutoNoteProbability)
          : AUTO_NOTE_DEFAULT_PROBABILITY;
      this.log('Gemini自動ノート投稿確率: probability=' + probability);
    }

    return {
      mentionHook: this.mentionHook,
      contextHook: this.contextHook,
      timeoutCallback: this.timeoutCallback,
    };
  }

  @bindThis
  private isYoutubeUrl(url: string): boolean {
    return (
      url.includes('www.youtube.com') ||
      url.includes('m.youtube.com') ||
      url.includes('youtu.be')
    );
  }

  @bindThis
  private normalizeYoutubeUrl(url: string): string {
    try {
      // URLオブジェクトを使用してパラメータを正確に解析
      const urlObj = new URL(url);
      let videoId = '';

      // youtu.beドメインの場合
      if (urlObj.hostname.includes('youtu.be')) {
        // パスから直接ビデオIDを取得
        videoId = urlObj.pathname.split('/')[1];
      }
      // youtube.comドメインの場合
      else if (urlObj.hostname.includes('youtube.com')) {
        // URLSearchParamsを使用してvパラメータを取得
        videoId = urlObj.searchParams.get('v') || '';
      }

      // ビデオIDが見つかった場合は標準形式のURLを返す
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    } catch (error) {
      this.log(`YouTube URL解析エラー: ${error}`);
    }

    // 解析に失敗した場合は元のURLを返す
    return url;
  }

  @bindThis
  private async genTextByGemini(aiChat: AiChat, files: base64File[]) {
    this.log('Generate Text By Gemini...');
    let parts: GeminiParts = [];
    const now = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    let systemInstructionText =
      aiChat.prompt +
      'また、現在日時は' +
      now +
      'であり、これは回答の参考にし、絶対に時刻を聞かれるまで時刻情報は提供しないこと(なお、他の日時は無効とすること)。';
    if (aiChat.friendName != undefined) {
      systemInstructionText +=
        'なお、会話相手の名前は' + aiChat.friendName + 'とする。';
    }
    // ランダムトーク機能(利用者が意図(メンション)せず発動)の場合、ちょっとだけ配慮しておく
    if (!aiChat.fromMention) {
      systemInstructionText +=
        'これらのメッセージは、あなたに対するメッセージではないことを留意し、返答すること(会話相手は突然話しかけられた認識している)。';
    }
    // グラウンディングについてもsystemInstructionTextに追記(こうしないとあまり使わないので)
    if (aiChat.grounding) {
      systemInstructionText += '返答のルール2:Google search with grounding.';
    }

    // YouTubeリンクの検出とpartsへの追加
    let youtubeURLs: string[] = [];
    let hasYoutubeUrl = false;

    // URLから情報を取得
    if (aiChat.question !== undefined) {
      const urlexp = RegExp("(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)", 'g');
      const urlarray = [...aiChat.question.matchAll(urlexp)];
      if (urlarray.length > 0) {
        for (const url of urlarray) {
          this.log('URL:' + url[0]);

          // YouTubeのURLの場合は特別処理
          if (this.isYoutubeUrl(url[0])) {
            this.log('YouTube URL detected: ' + url[0]);
            const normalizedUrl = this.normalizeYoutubeUrl(url[0]);
            this.log('Normalized YouTube URL: ' + normalizedUrl);
            youtubeURLs.push(normalizedUrl);
            hasYoutubeUrl = true;
            continue;
          }

          let result: unknown = null;
          try {
            result = await urlToJson(url[0]);
          } catch (err: unknown) {
            systemInstructionText +=
              '補足として提供されたURLは無効でした:URL=>' + url[0];
            this.log('Skip url becase error in urlToJson');
            continue;
          }
          const urlpreview: UrlPreview = result as UrlPreview;
          if (urlpreview.title) {
            systemInstructionText +=
              '補足として提供されたURLの情報は次の通り:URL=>' +
              urlpreview.url +
              'サイト名(' +
              urlpreview.sitename +
              ')、';
            if (!urlpreview.sensitive) {
              systemInstructionText +=
                'タイトル(' +
                urlpreview.title +
                ')、' +
                '説明(' +
                urlpreview.description +
                ')、' +
                '質問にあるURLとサイト名・タイトル・説明を組み合わせ、回答の参考にすること。';
              this.log('urlpreview.sitename:' + urlpreview.sitename);
              this.log('urlpreview.title:' + urlpreview.title);
              this.log('urlpreview.description:' + urlpreview.description);
            } else {
              systemInstructionText +=
                'これはセンシティブなURLの可能性があるため、質問にあるURLとサイト名のみで、回答の参考にすること(使わなくても良い)。';
            }
          } else {
            // 多分ここにはこないが念のため
            this.log('urlpreview.title is nothing');
          }
        }
      }
    }
    const systemInstruction: GeminiSystemInstruction = {
      role: 'system',
      parts: [{ text: systemInstructionText }],
    };

    // ファイルが存在する場合、ファイルを添付して問い合わせ
    parts = [{ text: aiChat.question }];

    // YouTubeのURLをfileDataとして追加
    for (const youtubeURL of youtubeURLs) {
      parts.push({
        fileData: {
          mimeType: 'video/mp4',
          fileUri: youtubeURL,
        },
      });
    }

    // 画像ファイルを追加
    if (files.length >= 1) {
      for (const file of files) {
        parts.push({
          inlineData: {
            mimeType: file.type,
            data: file.base64,
          },
        });
      }
    }

    let contents: GeminiContents[] = [];
    if (aiChat.history != null) {
      aiChat.history.forEach((entry) => {
        contents.push({
          role: entry.role,
          parts: [{ text: entry.content }],
        });
      });
    }
    contents.push({ role: 'user', parts: parts });

    let geminiOptions: GeminiOptions = {
      contents: contents,
      systemInstruction: systemInstruction,
    };

    // YouTubeURLがある場合はグラウンディングを無効化
    if (aiChat.grounding && !hasYoutubeUrl) {
      geminiOptions.tools = [{ google_search: {} }];
    }

    let options = {
      url: aiChat.api,
      searchParams: {
        key: aiChat.key,
      },
      json: geminiOptions,
    };
    this.log(JSON.stringify(options));
    let res_data: any = null;
    let responseText: string = '';
    try {
      res_data = await got
        .post(options, { parseJson: (res: string) => JSON.parse(res) })
        .json();
      this.log(JSON.stringify(res_data));
      if (res_data.hasOwnProperty('candidates')) {
        if (res_data.candidates?.length > 0) {
          // 結果を取得
          if (res_data.candidates[0].hasOwnProperty('content')) {
            if (res_data.candidates[0].content.hasOwnProperty('parts')) {
              for (
                let i = 0;
                i < res_data.candidates[0].content.parts.length;
                i++
              ) {
                if (
                  res_data.candidates[0].content.parts[i].hasOwnProperty('text')
                ) {
                  responseText += res_data.candidates[0].content.parts[i].text;
                }
              }
            }
          }
        }
        // groundingMetadataを取得
        let groundingMetadata = '';
        if (res_data.candidates[0].hasOwnProperty('groundingMetadata')) {
          // 参考サイト情報
          if (
            res_data.candidates[0].groundingMetadata.hasOwnProperty(
              'groundingChunks'
            )
          ) {
            // 参考サイトが多すぎる場合があるので、3つに制限
            let checkMaxLength =
              res_data.candidates[0].groundingMetadata.groundingChunks.length;
            if (
              res_data.candidates[0].groundingMetadata.groundingChunks.length >
              3
            ) {
              checkMaxLength = 3;
            }
            for (let i = 0; i < checkMaxLength; i++) {
              if (
                res_data.candidates[0].groundingMetadata.groundingChunks[
                  i
                ].hasOwnProperty('web')
              ) {
                if (
                  res_data.candidates[0].groundingMetadata.groundingChunks[
                    i
                  ].web.hasOwnProperty('uri') &&
                  res_data.candidates[0].groundingMetadata.groundingChunks[
                    i
                  ].web.hasOwnProperty('title')
                ) {
                  groundingMetadata += `参考(${i + 1}): [${
                    res_data.candidates[0].groundingMetadata.groundingChunks[i]
                      .web.title
                  }](${
                    res_data.candidates[0].groundingMetadata.groundingChunks[i]
                      .web.uri
                  })\n`;
                }
              }
            }
          }
          // 検索ワード
          if (
            res_data.candidates[0].groundingMetadata.hasOwnProperty(
              'webSearchQueries'
            )
          ) {
            if (
              res_data.candidates[0].groundingMetadata.webSearchQueries.length >
              0
            ) {
              groundingMetadata +=
                '検索ワード: ' +
                res_data.candidates[0].groundingMetadata.webSearchQueries.join(
                  ','
                ) +
                '\n';
            }
          }
        }
        responseText += groundingMetadata;
      }
    } catch (err: unknown) {
      this.log('Error By Call Gemini');
      if (err instanceof Error) {
        this.log(`${err.name}\n${err.message}\n${err.stack}`);
      }
    }
    return responseText;
  }

  @bindThis
  private async note2base64File(notesId: string) {
    const noteData = await this.ai.api('notes/show', { noteId: notesId });
    let files: base64File[] = [];
    if (noteData !== null && noteData.hasOwnProperty('files')) {
      for (let i = 0; i < noteData.files.length; i++) {
        let fileType: string | undefined;
        let fileUrl: string | undefined;
        if (noteData.files[i].hasOwnProperty('type')) {
          fileType = noteData.files[i].type;
        }
        if (
          noteData.files[i].hasOwnProperty('thumbnailUrl') &&
          noteData.files[i].thumbnailUrl
        ) {
          fileUrl = noteData.files[i].thumbnailUrl;
        } else if (
          noteData.files[i].hasOwnProperty('url') &&
          noteData.files[i].url
        ) {
          fileUrl = noteData.files[i].url;
        }
        if (fileType !== undefined && fileUrl !== undefined) {
          try {
            this.log('fileUrl:' + fileUrl);
            const file = await urlToBase64(fileUrl);
            const base64file: base64File = { type: fileType, base64: file };
            files.push(base64file);
          } catch (err: unknown) {
            if (err instanceof Error) {
              this.log(`${err.name}\n${err.message}\n${err.stack}`);
            }
          }
        }
      }
    }
    return files;
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes([this.name])) {
      return false;
    } else {
      this.log('AiChat requested');

      const relation = await this.ai?.api('users/relation', {
        userId: msg.userId,
      });
      // this.log('Relation data:' + JSON.stringify(relation));

      if (relation[0]?.isFollowing !== true) {
        this.log('The user is not following me:' + msg.userId);
        msg.reply('あなたはaichatを実行する権限がありません。');
        return false;
      }
    }

    const conversationData = await this.ai.api('notes/conversation', {
      noteId: msg.id,
    });

    let exist: AiChatHist | null = null;
    if (conversationData != undefined) {
      for (const message of conversationData) {
        exist = this.aichatHist.findOne({ postId: message.id });
        if (exist != null) return false;
      }
    }

    let type = TYPE_GEMINI;
    const current: AiChatHist = {
      postId: msg.id,
      createdAt: Date.now(),
      type: type,
      fromMention: true,
    };
    if (msg.quoteId) {
      const quotedNote = await this.ai.api('notes/show', {
        noteId: msg.quoteId,
      });
      current.history = [
        {
          role: 'user',
          content:
            'ユーザーが与えた前情報である、引用された文章: ' + quotedNote.text,
        },
      ];
    }

    const result = await this.handleAiChat(current, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  @bindThis
  private async contextHook(key: any, msg: Message) {
    this.log('contextHook...');
    if (msg.text == null) return false;

    // msg.idをもとにnotes/conversationを呼び出し、該当のidかチェック
    const conversationData = await this.ai.api('notes/conversation', {
      noteId: msg.id,
    });

    // 結果がnullやサイズ0の場合は終了
    if (conversationData == null || conversationData.length == 0) {
      this.log('conversationData is nothing.');
      return false;
    }

    const relation = await this.ai.api('users/relation', {
      userId: msg.userId,
    });
    if (relation[0]?.isFollowing !== true) {
      this.log('The user is not following me: ' + msg.userId);
      msg.reply('あなたはaichatを実行する権限がありません。');
      return false;
    }

    let exist: AiChatHist | null = null;
    for (const message of conversationData) {
      exist = this.aichatHist.findOne({ postId: message.id });
      if (exist != null) break;
    }
    if (exist == null) {
      this.log('conversationData is not found.');
      return false;
    }

    this.unsubscribeReply(key);
    this.aichatHist.remove(exist);

    const result = await this.handleAiChat(exist, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  @bindThis
  private async aichatRandomTalk() {
    this.log('AiChat(randomtalk) started');
    const tl = await this.ai.api('notes/timeline', { limit: 30 });
    const interestedNotes = tl.filter(
      (note) =>
        note.userId !== this.ai.account.id &&
        note.text != null &&
        note.replyId == null &&
        note.renoteId == null &&
        note.cw == null &&
        (note.visibility === 'public' || note.visibility === 'home') &&
        note.files.length == 0 &&
        !note.user.isBot
    );

    if (interestedNotes == undefined || interestedNotes.length == 0)
      return false;

    if (Math.random() >= this.randomTalkProbability) return false;

    const choseNote =
      interestedNotes[Math.floor(Math.random() * interestedNotes.length)];

    // aichatHistに該当のポストが見つかった場合は会話中のためaichatRandomTalkでは対応しない
    let exist: AiChatHist | null = null;

    // 選択されたノート自体が会話中のidかチェック
    exist = this.aichatHist.findOne({
      postId: choseNote.id,
    });
    if (exist != null) return false;

    // msg.idをもとにnotes/childrenを呼び出し、会話中のidかチェック
    const childrenData = await this.ai.api('notes/children', {
      noteId: choseNote.id,
    });
    if (childrenData != undefined) {
      for (const message of childrenData) {
        exist = this.aichatHist.findOne({
          postId: message.id,
        });
        if (exist != null) return false;
      }
    }

    // msg.idをもとにnotes/conversationを呼び出し、会話中のidかチェック
    const conversationData = await this.ai.api('notes/conversation', {
      noteId: choseNote.id,
    });

    if (conversationData != undefined) {
      for (const message of conversationData) {
        exist = this.aichatHist.findOne({ postId: message.id });
        if (exist != null) return false;
      }
    }

    exist = this.aichatHist.findOne({ originalNoteId: choseNote.id });
    if (exist != null) {
      this.log('Already replied to this note via originalNoteId');
      return false;
    }

    // const friend: Friend | null = this.ai.lookupFriend(choseNote.userId);
    // if (friend == null || friend.love < 7 || choseNote.user.isBot) return false;
    if (choseNote.user.isBot) return false;

    const relation = await this.ai.api('users/relation', {
      userId: choseNote.userId,
    });

    if (relation[0]?.isFollowing === true) {
      const current: AiChatHist = {
        postId: choseNote.id,
        createdAt: Date.now(),
        type: TYPE_GEMINI,
        fromMention: false,
      };

      let targetedMessage = choseNote;
      if (choseNote.extractedText == undefined) {
        const data = await this.ai.api('notes/show', { noteId: choseNote.id });
        targetedMessage = new Message(this.ai, data);
      }

      const result = await this.handleAiChat(current, targetedMessage);

      if (result) {
        return { reaction: 'like' };
      }
    }

    return false;
  }

  @bindThis
  private async autoNote() {
    if (
      config.geminiAutoNoteProbability !== undefined &&
      !isNaN(Number.parseFloat(config.geminiAutoNoteProbability))
    ) {
      const probability = Number.parseFloat(config.geminiAutoNoteProbability);
      if (Math.random() >= probability) {
        this.log(
          `Gemini自動ノート投稿の確率によりスキップされました: probability=${probability}`
        );
        return;
      }
    }
    this.log('Gemini自動ノート投稿開始');
    if (!config.geminiApiKey || !config.autoNotePrompt) {
      this.log('APIキーまたは自動ノート用プロンプトが設定されていません。');
      return;
    }
    const aiChat: AiChat = {
      question: '',
      prompt: config.autoNotePrompt,
      api: GEMINI_API,
      key: config.geminiApiKey,
      fromMention: false,
    };
    const base64Files: base64File[] = []; // 自動ノートの場合はファイルは添付しない
    const text = await this.genTextByGemini(aiChat, base64Files);
    if (text) {
      this.ai.post({ text: text + ' #aichat' });
    } else {
      this.log('Gemini自動ノートの生成に失敗しました。');
    }
  }

  @bindThis
  private async handleAiChat(exist: AiChatHist, msg: Message) {
    let text: string | null, aiChat: AiChat;
    let prompt: string = '';
    if (config.prompt) {
      prompt = config.prompt;
    }

    // groudingサポート
    if (msg.includes([GROUNDING_TARGET])) {
      exist.grounding = true;
    }
    // 設定で、デフォルトgroundingがONの場合、メンションから来たときは強制的にgroundingをONとする(ランダムトークの場合は勝手にGoogle検索するのちょっと気が引けるため...)
    if (
      exist.fromMention &&
      config.aichatGroundingWithGoogleSearchAlwaysEnabled
    ) {
      exist.grounding = true;
    }

    const reName = RegExp(this.name, 'i');
    const extractedText = msg.extractedText;
    if (extractedText == undefined || extractedText.length == 0) return false;

    let question = extractedText
      .replace(reName, '')
      .replace(GROUNDING_TARGET, '')
      .trim();

    const friend: Friend | null = this.ai.lookupFriend(msg.userId);
    let friendName: string | undefined;
    if (friend != null && friend.name != null) {
      friendName = friend.name;
    } else if (msg.user.name) {
      friendName = msg.user.name;
    } else {
      friendName = msg.user.username;
    }

    // Ensure Gemini API key is set
    if (!config.geminiApiKey) {
      msg.reply(serifs.aichat.nothing(exist.type));
      return false;
    }

    aiChat = {
      question: question,
      prompt: prompt,
      api: GEMINI_API,
      key: config.geminiApiKey,
      history: exist.history,
      friendName: friendName,
      fromMention: exist.fromMention,
    };

    const base64Files: base64File[] = await this.note2base64File(msg.id);
    text = await this.genTextByGemini(aiChat, base64Files);

    if (text == null || text == '') {
      this.log(
        'The result is invalid. It seems that tokens and other items need to be reviewed.'
      );
      msg.reply(serifs.aichat.error(exist.type));
      return false;
    }

    msg.reply(serifs.aichat.post(text)).then((reply) => {
      if (!exist.history) {
        exist.history = [];
      }
      exist.history.push({ role: 'user', content: question });
      exist.history.push({ role: 'model', content: text });
      if (exist.history.length > 10) {
        exist.history.shift();
      }
      this.aichatHist.insertOne({
        postId: reply.id,
        createdAt: Date.now(),
        type: exist.type,
        api: aiChat.api,
        history: exist.history,
        grounding: exist.grounding,
        fromMention: exist.fromMention,
        originalNoteId: exist.postId,
      });

      this.subscribeReply(reply.id, reply.id);
      this.setTimeoutWithPersistence(TIMEOUT_TIME, { id: reply.id });
    });
    return true;
  }

  @bindThis
  private async timeoutCallback({ id }) {
    this.log('timeoutCallback...');
    const exist = this.aichatHist.findOne({ postId: id });
    this.unsubscribeReply(id);
    if (exist != null) {
      this.aichatHist.remove(exist);
    }
  }
}
