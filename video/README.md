# 유튜브 영상 작업 (video)

세무 관련 유튜브 영상을 만드는 작업 폴더입니다.

## 폴더 구성

```
video/
└── lipsync-pipeline/     # 캐릭터 이미지 + 대본 → 립싱크 영상 자동 제작 도구
    ├── README.md         # 쉬운 안내서 (먼저 읽으세요)
    ├── PROCESS.md        # 상세 기술 문서
    ├── package.json      # 필요한 부품(라이브러리) 목록
    └── ...
```

## 시작하기

영상 제작 도구의 사용법과 현재 상태는 [`lipsync-pipeline/README.md`](lipsync-pipeline/README.md)에
쉬운 말로 정리되어 있습니다. 먼저 그 문서를 읽어 주세요.

## 현재 상태 요약

- 제작 과정 문서(`PROCESS.md`)와 프로젝트 설정 파일은 올라와 있습니다.
- **실제 실행 스크립트(`bin/`)와 원본 캐릭터 이미지·대본(`assets/`)은 아직 저장소에 없습니다.**
  이 자료들이 있어야 영상이 만들어집니다. 자세한 내용은
  [`lipsync-pipeline/README.md`](lipsync-pipeline/README.md)의 "2. 지금 이 폴더의 상태"를 참고하세요.
