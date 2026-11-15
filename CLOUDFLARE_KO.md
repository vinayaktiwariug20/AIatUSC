# AIatUSC · VS Code에서 실행하고 Cloudflare에 배포하기

기존 프로젝트는 Python으로 구현돼 있었습니다. 수정본에는 기존 지도 화면과 데이터를 사용하는 **Cloudflare용 JavaScript API**와 루트 `package.json`을 추가했습니다.
원본 Python 서버·테스트·데이터는 유지합니다. Node.js 24 LTS를 권장합니다.

## 1. 수정본 폴더 열기

1. 이 ZIP을 새 위치에 압축 해제합니다. 기존 폴더에 별도로 수정한 내용이 있다면 먼저 백업하세요.
2. VS Code에서 **File → Open Folder…**로 수정본의 `AIatUSC-main` 폴더를 엽니다.
3. 왼쪽에 `package.json`, `CLOUDFLARE_KO.md`, `outdoor-nav`가 함께 보여야 합니다.
4. 기존 터미널은 종료하고 **Terminal → New Terminal**을 엽니다.

아래 명령은 전부 **`AIatUSC-main` 최상위 폴더**에서 실행합니다. `outdoor-nav`로 이동하지 마세요.

```bash
pwd
ls package.json
node -v
npm -v
```

## 2. 설치·로컬 실행

```bash
npm install
npm run check
npm test
npm run dev
```

터미널에 표시되는 주소를 브라우저에서 엽니다. 기본값은 `http://localhost:8787`입니다.
지도에 출발지를 찍고 목적지에 `Doheny`를 입력한 뒤 **Go**를 눌러 기존 도보 경로를 확인하세요.

처음에는 `Read-only preview`라고 나옵니다. D1을 연결하기 전에는 제보를 저장하지 않는 정상적인 초기 상태입니다.
로컬 서버를 종료할 때는 터미널에서 `Control + C`를 누릅니다.

`npm install`이 만든 `package-lock.json`은 나중에 GitHub에도 함께 커밋하세요. `node_modules`와 `.dev.vars`는 커밋하지 않습니다.
VS Code의 **Terminal → Run Task…**에도 로컬 실행·테스트·배포 작업을 넣었습니다.

## 3. Cloudflare 로그인·첫 배포

로컬 서버를 종료한 다음 실행하세요.

```bash
npm run cf:login
npm run deploy
```

브라우저에서 본인의 Cloudflare 계정을 확인하고 Wrangler 권한을 직접 검토해 로그인합니다.
Workers Free 플랜으로 시작합니다. 기본 `workers.dev` HTTPS 주소를 사용하므로 도메인을 구매할 필요는 없습니다.

배포 완료 후 터미널에 표시된 **실제 배포 주소**를 엽니다. 그 주소 뒤에 `/api/health`를 붙여 API 연결도 확인하세요.

```json
{
  "ok": true,
  "app": "AIatUSC",
  "runtime": "cloudflare-javascript",
  "database": "not_configured",
  "storage": "read_only_preview",
  "timezone": "America/Los_Angeles",
  "walking_routes": true,
  "driving_routes": false,
  "turn_by_turn": false,
  "public_reports": false
}
```

D1 없이도 지도·기존 도보 경로·건물 조회·차량 게이트 시간표를 확인할 수 있습니다. 읽기 전용 배포에서는 통제 저장·승인·삭제가 거부됩니다.
기존 로컬 `data/closures.json`의 제보는 자동 업로드하지 않습니다.

## 4. D1 영구 저장 연결

프로젝트 루트에서 새 데이터베이스를 만듭니다.

```bash
npm run db:create
```

설정 자동 추가를 묻는다면 **No**를 선택하고 아래 도구를 사용하세요.
출력에 나온 실제 `database_id`를 복사합니다. 아래 설명 부분을 실제 UUID로 바꿔 실행합니다.

```bash
npm run db:bind -- 실제-database_id
```

도구가 `outdoor-nav/wrangler.jsonc`에 `DB` 바인딩을 넣습니다. 기존의 다른 데이터베이스 바인딩은 임의로 바꾸지 않습니다.
새로 만든 이 프로젝트용 DB에만 다음 마이그레이션을 적용하세요.

```bash
npm run db:local
npm run db:remote
```

원격 적용 프롬프트에서 대상이 `aiatusc-closures`인지 확인합니다. 기존 테이블을 삭제하는 SQL은 없습니다.
관리자 토큰을 Cloudflare Secret으로 등록한 다음 재배포합니다.

```bash
npm run secret:admin
npm run deploy
```

토큰은 본인만 아는 긴 임의의 값을 사용합니다. GitHub·URL·채팅에 올리지 마세요.
웹앱 **Staff / organizer**에 같은 토큰을 입력하면 통제를 등록·승인·해제할 수 있습니다.
토큰은 브라우저 영구 저장소에 남기지 않으므로 새로고침 후 다시 입력합니다.

`/api/health`의 `database`가 `connected`인지 확인하세요. 테이블이 없으면 `migration_required`와 503을 반환합니다.

## 5. 일반 방문자 제보 켜기

첫 공개 배포에서는 일반 방문자의 쓰기를 꺼두었습니다. D1·관리자 기능 확인 후 필요할 때 다음 설정을 바꾸고 재배포하세요.

`outdoor-nav/wrangler.jsonc`:

```json
"PUBLIC_REPORTS_ENABLED": "true"
```

일반 제보는 `unverified`로 저장되고 관리자 승인 전에는 경로를 바꾸지 않습니다.
관리자 토큰이 있는 사용자의 제보는 `approved`로 저장합니다. 종료 시각이 지나면 자동으로 경로 통제에서 제외됩니다.
D1에는 제보를 한 건씩 저장하므로 다른 요청의 제보 목록 전체를 덮어쓰지 않습니다.
연결된 D1이 실패하면 통제를 무시한 경로를 내보내는 대신 오류를 반환합니다.

로컬 관리자 테스트는 `outdoor-nav/.dev.vars.example`을 같은 폴더의 `.dev.vars`로 복사해 토큰을 설정합니다.

## 현재 구현 범위

| 기능 | 상태 |
| --- | --- |
| 교내 지도·건물 조회·도보 경로 | 기존 기능 유지 |
| 승인된 통제 구간 회피·계단 회피 | 구현됨 |
| 제보 영구 저장·관리자 승인 | D1 연결 후 사용 |
| 차량 게이트 운영시간 조회 | 기존 정적 시간표 유지 |
| 차량 운전 경로·주차장 진입구 안내 | 미구현 |
| 차량·도보 선택 옵션 | 미구현 |
| 회전·음성 안내 | 미구현; 현재 경로선 안내 |
| 실시간 교통·실시간 주차 잔여 자리 | 미구현 |
| 행사 생성·QR 자동 발급 | 미구현; 기존 URL 공유 가능 |
| 사진 기반 실내 안내 | 미구현; 기존 입구 인계 데이터만 유지 |

주차장에서 시작하는 현재 경로도 **도보 경로**입니다. 차량 운영시간으로 보행로를 막지 않는 원래 로직을 유지합니다.
실제 문이 매핑되지 않은 건물은 `entrance_source: outline`으로 표시합니다. 행사장의 문 위치는 현장 검증이 필요합니다.
차량 게이트 시간표는 경기 당일 최신 통제의 실시간 피드가 아닙니다.

## 파일별 역할

| 파일 | 역할 |
| --- | --- |
| `package.json` | VS Code 터미널용 실행·테스트·배포 명령 |
| `outdoor-nav/wrangler.jsonc` | Cloudflare 배포 설정 |
| `outdoor-nav/cloudflare/worker.mjs` | 웹 화면과 API 진입점 |
| `outdoor-nav/cloudflare/api.mjs` | API·관리자 확인·D1 저장·학교 현지 시간 처리 |
| `outdoor-nav/cloudflare/router.mjs` | Cloudflare용 경로 계산 |
| `outdoor-nav/cloudflare/graph.json` | 기존 Python 그래프에서 미리 생성한 읽기 전용 데이터 |
| `outdoor-nav/migrations/0001_closures.sql` | 제보 테이블과 인덱스 |
| `outdoor-nav/outdoor/static/index.html` | 기존 지도 UI와 배포 상태 안내 |
| `outdoor-nav/outdoor/*.py` | 원본 Python 구현 |

## 데이터나 Python 경로 코드를 바꾸면

기존 `data/*.json`을 수정했다면 Python 3.9 이상이 있는 환경에서 그래프를 다시 생성합니다.
배포 파일에 기존 그래프를 포함했으므로 첫 실행에는 이 단계가 필요 없습니다.

```bash
npm run build:graph
npm run check:parity
npm test
npm run deploy
```

`build:graph`는 원래 Python 그래프를 읽어 Cloudflare용 데이터와 공간 인덱스를 만듭니다.
Python 경로 **알고리즘 자체**를 바꾸면 JavaScript 구현도 함께 맞춰야 합니다. 자동으로 Python 코드를 번역하는 구조는 아닙니다.
`check:parity`는 원본 Python과 배포용 JavaScript의 실제 전체 경로 응답을 비교합니다.

원본 Python 서버를 계속 사용할 수도 있습니다.

```bash
cd outdoor-nav
python3 -m outdoor.server
```

기본 주소는 `http://localhost:8100`입니다. 이 로컬 실행은 원래처럼 JSON 파일 저장을 사용합니다. Cloudflare의 D1 저장과는 별개입니다.

## 검증과 무료 한도

- 원본 테스트 함수 17개를 표준 라이브러리 호환 실행기로 확인했습니다. 이것은 정식 pytest 실행과 구분됩니다.
- 새 배포 API는 Node의 실제 SQLite를 사용한 테스트로 확인했습니다.
- Python과 JavaScript의 전체 경로 응답을 비교했습니다. 제보·통제·계단·출입구 선택 등을 포함합니다.
- 관리자 토큰은 같은 출처 API로만 전송하고, 브라우저 영구 저장을 제거했습니다.
- 통제 목록을 30초마다 확인하되 실제 목록이 변할 때만 경로를 다시 계산합니다.
- 데이터셋과 배포용 그래프의 원본 해시를 검사해 변경 누락을 찾습니다.

Workers Free와 D1 Free 한도 내에서 시작하는 구성입니다. 요청·저장소·CPU 제한은 적용됩니다.
실제 Workers CPU 사용량과 휴대전화 GPS 동작은 배포 후 확인해야 하며, 로컬 성능 측정만으로 무제한 무료 운영을 보장하지 않습니다.
OSM 타일은 출처 표시와 사용 정책을 지켜야 하고 대량 다운로드·오프라인 저장 기능을 붙이지 않습니다.

제공 환경은 npm 레지스트리·Cloudflare 대시보드 접속이 제한되어 Wrangler 설치·실제 Cloudflare 배포를 실행하지 못했습니다.
따라서 `npm install`, `npm run dev`, 실제 계정 배포는 사용자 Mac에서 확인해야 합니다.
기존 pytest를 직접 실행하려면 별도 Python 개발환경에 pytest를 설치하고 `python3 -m pytest -q`를 사용할 수 있습니다.

## 공식 문서

- Workers 정적 웹 + API: https://developers.cloudflare.com/workers/static-assets/
- Wrangler 시작: https://developers.cloudflare.com/workers/get-started/guide/
- D1: https://developers.cloudflare.com/d1/get-started/
- Workers Free 한도: https://developers.cloudflare.com/workers/platform/pricing/
- OSM 타일 정책: https://operations.osmfoundation.org/policies/tiles/
