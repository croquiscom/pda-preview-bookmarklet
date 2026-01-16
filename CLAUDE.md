# Project: WMS Frontend DevTools (Hardware Simulators)

## 1. 프로젝트 개요
이 프로젝트는 물류 센터(WMS) 개발 환경에서 실물 하드웨어 장비 없이 프론트엔드 로직을 검증하기 위한 **"Bookmarklet 기반 가상 시뮬레이터 툴킷"**입니다.

### 핵심 목표
* **Hardware-less Testing:** 실물 장비(3D Sorter, PDA) 없이 바코드 스캔, 화면 레이아웃, 분류 로직을 브라우저상에서 테스트한다.
* **Zero Dependency:** 외부 라이브러리 없이 **순수 Vanilla JS**와 CSS만으로 동작해야 한다.
* **Plug & Play:** 기존 WMS 소스 코드를 수정하지 않고, 브라우저 콘솔이나 북마크릿을 통해 실행 즉시 오버레이(Overlay)된다.

---

## 2. 모듈 명세 (Module Specifications)

이 프로젝트는 크게 두 가지 독립적인 모듈로 구성됩니다.

### Module A: Virtual 3D Mini Sorter (DAS/Re-bin Simulator)
**목적:** 자동 분류기(Sorter)의 동작을 시뮬레이션하여 합포장(Batch Picking) 및 주문 분류 로직 검증.
**경로:** [mini-sorter.js](mini-sorter.js)

* **UI 구조:**
    * **Fixed Slots:** 20개의 물리적 고정 슬롯(Grid/List 형태).
    * **Master-Detail View:** 좌측은 슬롯 전체 현황, 우측은 선택된 슬롯의 상세 정보(주문 내역, 로그).
    * **Floating Window:** 드래그 이동(Drag & Drop) 및 접기/펼치기(Collapse) 지원.
* **핵심 로직 (DAS/Re-bin Algorithm):**
    1.  **로그인:** 작업대 ID(Workstation ID) 입력 후 가상 주문 데이터(Backlog) 생성.
    2.  **작업 시작:** 소스 토트(Source Tote) 바코드 스캔 → 입력창 Lock.
    3.  **분류 (Sorting):** SKU 바코드 스캔 시 다음 우선순위로 슬롯 배정:
        * **Priority 1 (기존 할당):** 현재 `ACTIVE` 상태인 슬롯 중 해당 SKU가 필요한 주문이 있는가? → 해당 슬롯으로 안내.
        * **Priority 2 (신규 할당):** 대기 중인 주문(Pool) 중 해당 SKU를 포함하는 주문이 있는가? → `EMPTY` 슬롯을 `ACTIVE`로 변경 후 할당.
        * **Exception:** 위 조건 불만족 시 에러 처리.

### Module B: PDA Preview Tool (Mobile Device Emulator)
**목적:** 데스크탑 브라우저에서 모바일 PDA 해상도를 에뮬레이션하고, 물리적 스캐너 입력을 가상화.
**경로:** [preview.js](preview.js)

* **UI 구조:**
    * **Device Frame:** 모바일 해상도(350px~500px 가변)를 가진 `iframe` 컨테이너.
    * **Scanner Interface:** 가상 바코드 입력창 및 스캔 버튼.
    * **History Panel:** 최근 스캔한 바코드 목록 (클릭 시 재입력).
* **핵심 로직:**
    * **Iframe Isolation:** 현재 페이지(`window.location.href`)를 iframe 내부에 로드하여 스타일 격리.
    * **Function Injection:** 입력된 바코드를 `iframe.contentWindow.scanBarcode(code)` 함수를 호출하여 주입 (WMS의 전역 스캔 함수 트리거).
    * **Navigation Control:** Iframe 내부의 뒤로가기 버튼 클릭 시 전체 페이지가 아닌 Iframe 내부 히스토리만 제어.

---

## 3. 개발 가이드라인 (Development Constraints)

AI 및 개발자는 코드 수정 시 다음 규칙을 엄격히 준수해야 합니다.

### 기술 스택
* **Language:** JavaScript (ES6+), CSS.
* **Framework:** None (No React, Vue, jQuery etc.). **Only Vanilla JS**.

### 코딩 컨벤션
1.  **IIFE (즉시 실행 함수):** 모든 코드는 `(function(){ ... })();` 블록 내부에 작성하여 WMS 글로벌 스코프 오염을 방지한다.
2.  **DOM 조작:**
    * HTML 문자열(`innerHTML`)보다는 `document.createElement`, `appendChild` 등을 사용하여 보안과 안정성을 확보한다.
    * 단, 복잡한 리스트 렌더링(Sorter Slot 등)의 경우 가독성을 위해 Template Literal을 허용한다.
3.  **CSS 격리:**
    * 모든 CSS 클래스명 앞에는 모듈별 접두사를 붙인다.
        * Sorter: `vms-` (e.g., `.vms-card`, `.vms-header`)
        * PDA: `pda-` (또는 별도 명시가 없다면 유니크한 ID 사용)
    * 가능하면 Inline Style보다는 `document.createElement('style')`을 통해 Head에 스타일을 주입한다.
4.  **Mock Data:**
    * 백엔드 API가 준비되지 않은 경우, 로직 내부에 가상 데이터 생성기(`generateMockOrders`)를 포함한다.

---

## 4. 데이터 모델 (참고용)

### Sorter Slot Object Structure
```javascript
{
    id: "SLOT-01",
    status: "EMPTY" | "ACTIVE" | "COMPLETE",
    assignedOrderId: "ORD-2024001",
    destTote: "BOX-101",
    scannedItems: { "SKU-A": 2, "SKU-B": 1 }, // 실제 스캔 수량
    logs: [ { time: "10:00:00", sku: "SKU-A" } ]
}