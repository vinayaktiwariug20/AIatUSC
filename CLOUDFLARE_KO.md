# AIatUSC · Cloudflare 배포

이미 배포하셨다면 [UPDATE_KO.md](UPDATE_KO.md)를 따르세요. 기존 DB ID와 Secret을 다시 만들 필요가 없습니다.

## 처음 설치하는 경우

Node.js 24 LTS와 VS Code를 설치하고 `package.json`이 있는 최상위 폴더에서 실행합니다.

```bash
npm install
npm run check
npm test
npm run dev
```

Wrangler가 표시하는 localhost 주소를 엽니다. D1 없는 상태는 읽기 전용 미리보기입니다.

```bash
npm run cf:login
npm run db:create
```

Wrangler가 바인딩 자동 추가를 물으면 No를 고르고 출력된 DB UUID를 사용합니다.

```bash
npm run db:bind -- 실제-database_id
npm run db:local
npm run db:remote
npm run secret:admin
npm run secret:routing
npm run deploy
```

`secret:admin`에는 관리자 토큰, `secret:routing`에는 본인의 openrouteservice API 키를 입력합니다. 도보만 사용할 때는 차량 키를 생략할 수 있습니다. 실제 Secret을 채팅·GitHub·코드에 넣지 마세요.

배포 주소의 `/api/health`를 확인하세요. 정상적인 전체 설정은 `database: connected`, `mobility_migration: ready`, `walking_routes: true`, `driving_routes: true`, `public_reports: true`입니다. 실시간 교통과 음성 길안내는 연결되지 않았으므로 `live_traffic: false`, `turn_by_turn: false`가 정상입니다.

일반 사용자 신고는 배포 설정에서 켜져 있습니다. 직원 승인 전에는 경로를 변경하지 않습니다. 직원 토큰은 브라우저 탭에서만 사용합니다. `data/closures.json`의 과거 로컬 제보는 D1으로 자동 업로드하지 않습니다.

## 평소 업데이트

```bash
npm run check
npm test
npm run deploy
```

새 migration이 있을 때만 `npm run db:local`과 `npm run db:remote`도 실행합니다. `data/walk.json`, 건물·현장 보행 자료나 원래 게이트 JSON을 수정하면 다음 순서로 그래프를 갱신하세요.

```bash
npm run build:graph
npm run check:parity
npm test
npm run deploy
```

`data/mobility.json`과 `data/football.json`만 수정할 때는 그래프 재생성이 필요 없습니다. 일정·자료의 검증 날짜도 함께 갱신하세요.

원본 Python 서버는 기존 도보 API를 보존하지만, 이번 웹 화면의 차량 API와 관리자 차량 통제는 Cloudflare JavaScript 런타임 전용입니다. 개발에는 `npm run dev`를 사용하세요.

구현 범위·현장 검증이 필요한 좌표·경기일 예방 우회와 실제 통제의 차이·무료 요청 제한은 [UPDATE_KO.md](UPDATE_KO.md)에 설명돼 있습니다. Workers 무료 플랜에서 실제 CPU 사용량은 배포 후 확인해야 합니다.
