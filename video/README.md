# 유튜브 영상 작업 (video)

세무 관련 유튜브 영상을 만드는 작업 폴더입니다.

## 폴더 구성

```
video/
└── lipsync-pipeline/     # 캐릭터 이미지 + 대본 → 립싱크 영상 자동 제작 도구
    ├── README.md         # 쉬운 안내서 (먼저 읽으세요)
    ├── PROCESS.md        # 상세 기술 문서
    ├── package.json      # 필요한 부품(라이브러리) 목록
    ├── bin/              # 실행 스크립트 본체 (36개)
    ├── closeup/          # 원본 캐릭터 이미지 + 대화장면 + 대본
    ├── input/            # 검수 설정(cast.json) + 대본·화자·타이밍 설정
    └── mcp/              # 생성형 립싱크(Flyworks) 연동 설정 (선택)
```

## 시작하기

영상 제작 도구의 사용법과 현재 상태는 [`lipsync-pipeline/README.md`](lipsync-pipeline/README.md)에
쉬운 말로 정리되어 있습니다. 먼저 그 문서를 읽어 주세요.

## 현재 상태 요약

- 제작 과정 문서(`PROCESS.md`)와 프로젝트 설정 파일이 올라와 있습니다.
- **실제 실행 스크립트(`bin/`), 원본 캐릭터 이미지·대본(`closeup/`), 검수 설정(`input/cast.json`)까지
  모두 저장소에 들어와 있습니다.** 영상을 실제로 렌더하는 데 필요한 코드와 자료가 갖춰졌습니다.
- **macOS·Windows·Linux(클라우드)를 모두 지원**합니다. 대사를 음성으로 읽는 기능이 더 이상
  맥 전용이 아니며, 파이프라인이 OS를 감지해 알맞은 한국어 TTS(맥 `say` / 윈도우 SAPI /
  리눅스 `espeak-ng`·`piper`)와 한국어 자막 폰트를 자동으로 고릅니다. 남은 것은 OS별
  준비물(TTS 엔진·한국어 폰트)뿐입니다. 자세한 내용은
  [`lipsync-pipeline/README.md`](lipsync-pipeline/README.md)의 "3. 실행에 필요한 환경"을 참고하세요.
- Linux(클라우드 VM)에서 대본→영상 전 과정을 실제로 렌더해 1080×1920 세로 영상 2종(대화·클로즈업)과
  한글 자막·립싱크 검증을 확인했습니다.
