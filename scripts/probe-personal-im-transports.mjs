#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const apps = [
  {
    id: 'daxiang',
    label: '大象',
    path: '/Applications/大象.app',
    executable: '/Applications/大象.app/Contents/MacOS/大象',
  },
  {
    id: 'qq',
    label: 'QQ',
    path: '/Applications/QQ.app',
    executable: '/Applications/QQ.app/Contents/MacOS/QQ',
  },
  {
    id: 'wechat',
    label: '微信',
    path: existsSync('/Applications/微信.app')
      ? '/Applications/微信.app'
      : '/Applications/WeChat.app',
    executable: existsSync('/Applications/微信.app')
      ? '/Applications/微信.app/Contents/MacOS/WeChat'
      : '/Applications/WeChat.app/Contents/MacOS/WeChat',
  },
];

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim();
  } catch {
    return '';
  }
}

function plistValue(appPath, key) {
  return run('/usr/libexec/PlistBuddy', [
    '-c',
    `Print :${key}`,
    `${appPath}/Contents/Info.plist`,
  ]);
}

function processIds(executable) {
  const output = run('/usr/bin/pgrep', ['-f', executable]);
  return output
    .split(/\s+/)
    .map((value) => Number(value))
    .filter(Number.isInteger);
}

function listeningPorts(pids) {
  const ports = new Set();
  for (const pid of pids) {
    const output = run('/usr/sbin/lsof', [
      '-nP',
      '-a',
      '-p',
      String(pid),
      '-iTCP',
      '-sTCP:LISTEN',
    ]);
    for (const match of output.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)) {
      const port = Number(match[1]);
      if (Number.isInteger(port)) {
        ports.add(port);
      }
    }
  }
  return [...ports].sort((left, right) => left - right);
}

async function fetchJson(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(2_000),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return {
      reachable: true,
      status: response.status,
      body,
    };
  } catch {
    return {
      reachable: false,
    };
  }
}

async function findDaxiangBridge(ports) {
  for (const port of ports) {
    const result = await fetchJson(`http://127.0.0.1:${port}/alive`);
    if (
      result.status === 200
      && result.body?.rescode === 0
      && Number.isInteger(result.body?.serverVersion)
    ) {
      return {
        reachable: true,
        port,
        serverVersion: result.body.serverVersion,
      };
    }
  }
  return {
    reachable: false,
  };
}

async function probeOneBot() {
  const baseUrl = process.env.MIMI_PERSONAL_QQ_ONEBOT_HTTP_URL?.replace(/\/+$/, '');
  if (!baseUrl) {
    return {
      configured: false,
      reachable: false,
      accountVerified: false,
    };
  }

  const token = process.env.MIMI_PERSONAL_QQ_ONEBOT_TOKEN;
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const status = await fetchJson(`${baseUrl}/get_status`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const login = await fetchJson(`${baseUrl}/get_login_info`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const accountVerified = (
    login.status === 200
    && login.body?.status === 'ok'
    && login.body?.data?.user_id !== undefined
  );

  return {
    configured: true,
    reachable: status.reachable && login.reachable,
    accountVerified,
  };
}

function commandAvailable(command) {
  return Boolean(run('/usr/bin/which', [command]));
}

function loadDaxiangWebPoc() {
  const defaultPath = fileURLToPath(
    new URL('../../daxiang-web-poc/experiment-result.json', import.meta.url),
  );
  const resultPath = process.env.MIMI_DAXIANG_WEB_POC_RESULT || defaultPath;
  if (!existsSync(resultPath)) {
    return {
      found: false,
      verified: false,
    };
  }

  try {
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    const verified = (
      result?.conclusion?.result === 'pass'
      && result?.scope?.target === 'owner-self-chat'
      && result?.scope?.sendAttempts === 1
      && result?.preflight?.webSyncReady === true
      && result?.preflight?.messageIdsUnique === true
      && result?.send?.newMessageIdObserved === true
      && result?.send?.receiptObserved === true
      && result?.receive?.incrementalDomMessageObserved === true
      && result?.receive?.sameMessageIdReloadedFromServerHistory === true
    );
    return {
      found: true,
      verified,
      executedAt: result?.executedAt || null,
      target: result?.scope?.target || null,
      sendAttempts: result?.scope?.sendAttempts ?? null,
      externalInboundBackgroundTested: false,
      reconnectTested: false,
      longRunningTested: false,
    };
  } catch {
    return {
      found: true,
      verified: false,
      invalidResult: true,
    };
  }
}

function hasNapCatProcess() {
  const processList = run('/bin/ps', ['ax', '-o', 'command=']);
  return /(?:^|[/\s])napcat(?:qq)?(?:[./\s]|$)/im.test(processList);
}

const installed = Object.fromEntries(
  apps.map((app) => [
    app.id,
    {
      installed: existsSync(app.path),
      runningPids: processIds(app.executable),
      version: plistValue(app.path, 'CFBundleShortVersionString') || null,
      build: plistValue(app.path, 'CFBundleVersion') || null,
    },
  ]),
);

const daxiangPorts = listeningPorts(installed.daxiang.runningPids);
const qqPorts = listeningPorts(installed.qq.runningPids);
const wechatPorts = listeningPorts(installed.wechat.runningPids);
const daxiangBridge = await findDaxiangBridge(daxiangPorts);
const daxiangWebPoc = loadDaxiangWebPoc();
const oneBot = await probeOneBot();
const napCatRunning = hasNapCatProcess();
const wxCliInstalled = commandAvailable('wx');

const report = {
  scope: {
    identity: 'owner-personal-account-only',
    cuaAllowed: false,
    botAccountsAllowed: false,
    excluded: [
      '大象开放平台机器人',
      'QQ 官方 Bot',
      '微信 iLink/OpenClaw Bot',
      'CUA/Accessibility/AppleScript',
    ],
  },
  channels: {
    daxiang: {
      client: installed.daxiang,
      localListeningPorts: daxiangPorts,
      candidate: '大象网页版个人账号 + Browser Companion DOM Bridge',
      localProtocolHandshakeReady: daxiangBridge.reachable,
      webPoc: daxiangWebPoc,
      handshakeReady: daxiangWebPoc.verified,
      accountVerified: daxiangWebPoc.verified,
      receiveReady: daxiangWebPoc.verified,
      receiveCoverage: daxiangWebPoc.verified ? 'selected-session-dom-bounded' : 'none',
      sendReady: daxiangWebPoc.verified,
      sendCoverage: daxiangWebPoc.verified ? 'owner-self-chat-confirmed' : 'none',
      roundTripTested: daxiangWebPoc.verified,
      productionReady: false,
      blocker: daxiangWebPoc.verified
        ? '最小收发闭环已通过；仍需验证其他账号后台入站、断线重连、离线补偿、长时间稳定性和 DOM 版本兼容。'
        : '未找到或未通过大象网页版个人账号 PoC 回执。',
    },
    qq: {
      client: installed.qq,
      localListeningPorts: qqPorts,
      candidate: '个人 QQ + NapCat/OneBot 11',
      napCatRunning,
      oneBot,
      accountVerified: oneBot.accountVerified,
      receiveReady: false,
      sendReady: false,
      roundTripTested: false,
      blocker: oneBot.accountVerified
        ? '个人账号协议已握手；仍需验证 WS 入站事件，并向安全目标发送 nonce 后回读确认。'
        : '当前个人 QQ 未安装或未配置 NapCat/OneBot；QQ 自带本地端口不是 OneBot API。',
    },
    wechat: {
      client: installed.wechat,
      localListeningPorts: wechatPorts,
      candidate: '个人微信本地只读数据库 + 独立非 CUA 发送协议',
      wxCliInstalled,
      accountVerified: false,
      receiveReady: false,
      sendReady: false,
      roundTripTested: false,
      blocker: wxCliInstalled
        ? 'wx-cli 只能只读本地消息；当前仍缺少适配微信 4.x macOS 的非 CUA 个人账号发送协议。'
        : '未配置个人微信读取工具，且当前未发现适配微信 4.x macOS 的非 CUA 个人账号发送协议。',
    },
  },
};

report.overallReady = Object.values(report.channels).every(
  (channel) => channel.receiveReady && channel.sendReady,
);

console.log(JSON.stringify(report, null, 2));

if (process.argv.includes('--require-ready') && !report.overallReady) {
  process.exitCode = 2;
}
