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

손님 휴대폰에서 접속해야 하므로 인터넷에 공개된 서버가 필요합니다.
Railway, Render, Fly.io 같은 서비스에 이 폴더를 올리고 `npm start`로 실행하면 됩니다.
배포 후 받은 주소를 `BASE_URL`에 넣고 `/admin/qr`에서 QR을 인쇄하세요.

대화 기록은 `data/messages.json`에 저장됩니다. 서버가 재시작돼도 유지되며,
직원 화면의 "대화 비우기 (퇴실)" 버튼으로 방별로 지울 수 있습니다.

## 빠른 버튼 문구 바꾸기

- 손님용: `public/guest.html`의 `QUICK` 배열
- 직원용: `public/admin.html`의 `QUICK` 배열
