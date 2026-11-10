# 방별 QR 채팅앱

손님이 방에 붙은 QR을 찍으면 `N번방 손님`으로 입장해 직원에게 바로 채팅을 보낼 수 있는 앱입니다.
직원은 한 화면에서 모든 방의 메시지를 보고 답장합니다.

## 실행

```bash
npm install
npm start
```

| 주소 | 설명 |
|---|---|
| `/admin` | 직원 화면 (비밀번호 기본값 `1234`) |
| `/admin/qr` | 방별 QR 인쇄 페이지 |
| `/r/1`, `/r/2` … | 손님 채팅 화면 (QR에 담기는 주소) |

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `ADMIN_PASSWORD` | `1234` | 직원 화면 비밀번호. **배포 전 반드시 변경** |
| `ROOM_COUNT` | `10` | 방 개수 (1번방 ~ N번방) |
| `ROOM_NAMES` | 없음 | 방 이름 직접 지정. 예: `101호,102호,201호,글램핑A` |
| `BASE_URL` | 요청 주소 자동 | QR에 들어갈 공개 주소. 예: `https://chat.mycamp.com` |

예시:

```bash
ADMIN_PASSWORD=우리비번 ROOM_NAMES="101호,102호,201호,202호" BASE_URL=https://chat.mycamp.com npm start
```

## 배포

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sukang-commits/room-chat)

1. 위 버튼을 누르고 Render에 로그인(GitHub 계정으로 가능)합니다.
2. `render.yaml`이 자동으로 읽혀 서비스·영구 디스크·비밀번호가 설정됩니다. "Apply"를 누릅니다.
3. 배포가 끝나면 `https://room-chat-xxxx.onrender.com` 형태의 주소가 나옵니다.
4. Render 대시보드 > room-chat > Environment 에서
   - `ADMIN_PASSWORD` 값을 확인(자동 생성됨)하거나 원하는 비밀번호로 바꾸고
   - `BASE_URL`에 위 주소를 추가합니다. (QR에 들어갈 주소)
   - 방 이름을 바꾸려면 `ROOM_NAMES`를 추가합니다. 예: `101호,102호,201호`
5. `https://받은주소/admin/qr` 에서 QR을 인쇄해 각 방에 붙입니다.

Starter 플랜(월 7달러)이 기본입니다. 무료 플랜은 영구 디스크가 없고 15분 미사용 시 잠들어 손님이 QR을 찍었을 때 수십 초를 기다려야 하므로 권장하지 않습니다.

Railway를 쓰려면 railway.app > New Project > Deploy from GitHub repo 에서 이 저장소를 고르면 됩니다(`Dockerfile`, `railway.json` 자동 인식). Volumes에서 `/data` 경로로 볼륨을 붙이세요.

대화 기록은 `data/messages.json`에 저장됩니다. 서버가 재시작돼도 유지되며,
직원 화면의 "대화 비우기 (퇴실)" 버튼으로 방별로 지울 수 있습니다.

## 빠른 버튼 문구 바꾸기

- 손님용: `public/guest.html`의 `QUICK` 배열
- 직원용: `public/admin.html`의 `QUICK` 배열
