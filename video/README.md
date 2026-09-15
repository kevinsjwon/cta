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
- 남은 것은 실행 환경뿐입니다. 대사를 음성으로 읽는 기능이 **맥(macOS)의 한국어 음성(`say`/Yuna)**
  에 의존하므로, 실제 렌더에는 맥 환경(또는 다른 TTS로의 교체)이 필요합니다. 자세한 내용은
  [`lipsync-pipeline/README.md`](lipsync-pipeline/README.md)의 "2. 지금 이 폴더의 상태"를 참고하세요.
