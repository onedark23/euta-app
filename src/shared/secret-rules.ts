// Secret rules for every local run (SPEC 프로젝트-관리 "secrets 규칙", PLAN_euta-cloud 결정 "secrets 규칙
// 적용 범위"): pure helpers shared by main and renderer — allowed-domain defaults/normalization and the
// Korean wording of the engine's rule messages. No Node/Electron imports (the renderer bundles this).

export const MAX_ALLOWED_DOMAINS = 20;

/** Host of an http(s) address, or '' when there is none. */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Domains a secret fill/type step may run on for a local environment: the saved list, or — when the
 * environment has none (older project.json, never edited) — the host of its address. Empty = nowhere.
 */
export function defaultDomains(env: { baseUrl?: string; allowedDomains?: string[] } | undefined): string[] {
  if (!env) return [];
  if (Array.isArray(env.allowedDomains)) return [...env.allowedDomains];
  const h = hostOf(env.baseUrl);
  return h ? [h] : [];
}

const HOST = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$|^\[[0-9a-f:.]+\]$/;

/**
 * One allowed-domain entry as typed by a person → a host name ("https://A.com:8080/x" → "a.com",
 * "*.a.com" / ".a.com" → "a.com"). Returns undefined for something that is not a host.
 */
export function cleanDomain(raw: string): string | undefined {
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = hostOf(s);
  else s = s.split(/[/?#]/)[0]!.replace(/:\d+$/, '');
  s = s.replace(/^\*?\.+/, '').replace(/\.+$/, '');
  return HOST.test(s) ? s : undefined;
}

/** Comma/space separated text → cleaned, de-duplicated list (invalid entries reported). */
export function parseDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const d = cleanDomain(part);
    if (!d) invalid.push(part);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid };
}

/**
 * Korean wording of the engine's secret-rule messages inside `message` (validation issues, step errors,
 * "validation failed:" logs). The rest of the text — e.g. the `steps[0].goto:` path prefix — is kept.
 */
export function koSecretRule(message: string): string {
  return message
    .replace(
      /\$\{secrets\.([^}]+)\} is only allowed in the value of a fill or type step(?: \(secret placement rule\)| in cloud runs)?/g,
      (_m, name: string) => `\${secrets.${name}} 는 입력 스텝(fill 의 value · type 의 text)에만 쓸 수 있습니다 — 주소·변수·확인·이름 등에 넣으면 테스트 계정이 바깥으로 나갈 수 있어 실행하지 않습니다 (secrets 규칙)`,
    )
    .replace(/secret input blocked: page host "([^"]*)" is not an allowed domain \(([^)]*)\)/g, (_m, host: string, list: string) =>
      list === 'no allowed domains configured'
        ? `테스트 계정 입력 차단: 이 환경에 허용 도메인이 없습니다(지금 페이지 "${host}") — 프로젝트 설정 → 환경에서 주소 또는 허용 도메인을 넣으세요 (secrets 규칙)`
        : `테스트 계정 입력 차단: 지금 페이지 "${host}" 는 허용 도메인(${list})이 아닙니다 — 프로젝트 설정 → 환경 → 허용 도메인에 추가하세요 (secrets 규칙)`,
    );
}
