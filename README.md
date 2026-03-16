# pda-preview-bookmarklet

GitHub Pages: https://croquiscom.github.io/pda-preview-bookmarklet/

## 구조

| 파일 | 설명 |
|------|------|
| `preview.js` | PDA Preview 북마클릿 소스 |
| `mini-sorter.js` | 가상 소터(DAS/Re-bin) 북마클릿 소스 |
| `index.template.html` | 북마클릿 설치 페이지 템플릿 |
| `index.html` | 빌드 결과물 (직접 수정하지 않음) |
| `build.js` | JS → minify → bookmarklet → index.html 생성 스크립트 |

## 개발 방법

### 1. JS 소스 수정

`preview.js` 또는 `mini-sorter.js`를 수정합니다.

### 2. index.html 빌드

```bash
node build.js
```

- `terser`가 로컬에 없어도 `npx -y terser`로 자동 설치됩니다.
- `index.template.html`의 플레이스홀더에 minify된 bookmarklet이 삽입되어 `index.html`이 생성됩니다.

### 3. 커밋 & 푸시

```bash
git add mini-sorter.js preview.js index.html
git commit -m "변경 내용"
git push
```

> **주의:** `index.html`을 직접 수정하지 마세요. `build.js` 실행 시 덮어씌워집니다.
