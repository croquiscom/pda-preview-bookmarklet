(function() {
    'use strict';

    // ========================================
    // 1. CONSTANTS & CONFIGURATION
    // ========================================
    const CONFIG = {
        GRID_COUNT: 20,
        MAX_HISTORY_SIZE: 50,
        WIDGET_ID: 'vms-rebin-fixed-root',
        STYLE_ID: 'vms-style-rebin-drag',
        API_ENDPOINT: '/api/graphql/GetFCAssignOrderAssortingStation',
        TOTE_API_ENDPOINT: '/api/graphql/GetFcTotePageList',
        TEST_MODE: false // Set to false to enforce Sorter Type checks
    };

    // ========================================
    // 2. STATE MANAGEMENT
    // ========================================
    const STATE = {
        // Authentication
        isLoggedIn: false,
        workstationId: null,
        stationId: null,
        sorterType: null,
        workflowId: null,
        workflowName: null,

        // UI State
        isCollapsed: false,
        isSidePanelOpen: true,
        selectedGridId: null,

        // Work State
        sourceTote: null,

        // Data
        grids: [],
        orderPool: [],
        toteInventory: {}, // { 'TOTE-ID': Set('SKU1', 'SKU2') }

        // History
        scanHistory: [],
        historyIndex: -1
    };

    // Helper to check if actions are allowed (Respects TEST_MODE)
    function isActionAllowed() {
        return CONFIG.TEST_MODE || STATE.sorterType === 'SORTER';
    }

    // ========================================
    // 2-1. UTILS (Cookie & JWT)
    // ========================================
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function parseJwt(token) {
        try {
            if (!token) return null;
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));

            return JSON.parse(jsonPayload);
        } catch (e) {
            console.error("JWT Parsing Error:", e);
            return null;
        }
    }

    // ========================================
    // 3. INITIALIZATION
    // ========================================
    function init() {
        // Test JWT Access (Check Cookie first, then LocalStorage as fallback)
        let token = getCookie('WMS_ACCESS_TOKEN');
        
        if (!token) {
            // HttpOnly 대비: LocalStorage의 흔한 키값들 확인
            const commonTokenKeys = ['WMS_ACCESS_TOKEN', 'accessToken', 'token', 'auth_token'];
            for (const key of commonTokenKeys) {
                const val = localStorage.getItem(key);
                if (val) {
                    token = val;
                    console.log(`ℹ️ [VMS] Token found in LocalStorage: ${key}`);
                    break;
                }
            }
        }

        const decoded = parseJwt(token);
        console.log("🔑 [VMS] WMS_ACCESS_TOKEN:", token ? "Found" : "Not Found (HttpOnly?)");
        if (decoded) console.log("📄 [VMS] Decoded JWT Payload:", decoded);

        removeExistingWidget();
        injectStyles();
        initializeGrids();
        createRootElement();
        renderLogin();
    }

    function removeExistingWidget() {
        const existing = document.getElementById(CONFIG.WIDGET_ID);
        if (existing) existing.remove();
    }

    function initializeGrids() {
        STATE.grids = Array(CONFIG.GRID_COUNT).fill(null).map((_, i) => createEmptyGrid(i + 1));
    }

    function createEmptyGrid(index) {
        return {
            id: `GRID-${String(index).padStart(2, '0')}`,
            status: 'EMPTY',
            destTote: null,
            assignedOrderId: null,
            scannedItems: {},
            logs: []
        };
    }

    function createRootElement() {
        const root = document.createElement('div');
        root.id = CONFIG.WIDGET_ID;
        document.body.appendChild(root);
        return root;
    }

    function getRootElement() {
        return document.getElementById(CONFIG.WIDGET_ID);
    }

    // ========================================
    // 5. API COMMUNICATION
    // ========================================
    async function fetchStationData(barcode) {
        const query = buildGraphQLQuery();

        try {
            const response = await fetch(CONFIG.API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    query: query,
                    variables: { barcode: barcode }
                })
            });

            const json = await response.json();

            if (json.errors && json.errors.length > 0) {
                alert(json.errors[0].message);
                return false;
            }

            if (json.data && json.data.fc_order_assorting_station_state) {
                mapServerDataToState(json.data.fc_order_assorting_station_state);
                
                // Auto-fill totes if needed (await logic is optional here, we can let it run in background)
                // But since we want to show the final state, we await it.
                await autoFillTotes(); 
                
                // updateAllUI is called inside autoFillTotes if changes happened.
                // If no changes, we should call it here to ensure UI is rendered at least once.
                updateAllUI(); 
                
                return true;
            }

            throw new Error("Invalid Response Structure");

        } catch (error) {
            console.error("Fetch Error:", error);
            return false;
        }
    }

    async function fetchUnassignedTotes() {
        const query = `
            query GetFcTotePageList($search_input: FCToteSearchInput!, $page_input: FCPageInput!) {
                fc_tote_page_list(search_input: $search_input, page_input: $page_input) {
                    tote_list {
                        tote_barcode
                    }
                }
            }
        `;

        try {
            const response = await fetch(CONFIG.TOTE_API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    variables: {
                        search_input: { domain_type: "NONE", assign_type: "NOT_ASSIGNED" },
                        page_input: { page: 7, page_size: STATE.grids.length || CONFIG.GRID_COUNT }
                    }
                })
            });

            const json = await response.json();
            return json?.data?.fc_tote_page_list?.tote_list || [];
        } catch (e) {
            console.error("Tote Fetch Error:", e);
            return [];
        }
    }

    async function sendDropFeedback(grid, skuBarcode) {
        if (!STATE.stationId) return false;

        const order = STATE.orderPool.find(o => o.orderId === grid.assignedOrderId);
        if (!order) return false;

        // Find skuId from barcode
        let skuId = skuBarcode;
        // Check skuInfo for mapping
        if (order.skuInfo && order.skuInfo[skuBarcode]) {
            skuId = order.skuInfo[skuBarcode].id;
        }

        const gridNo = grid.id.replace('GRID-', '').replace(/^0+/, ''); // GRID-02 -> 2

        const payload = {
            "pickingContainerNo" : STATE.sourceTote,
            "skuNo" : skuId,
            "containerNo" : grid.destTote,
            "waveNo" : STATE.workflowId,
            "orderNo" : grid.assignedOrderId,
            "gridNo" : gridNo,
            "stationId" : String(STATE.stationId),
            "centerId" : "5"
        };

        try {
            const res = await fetch('/api/sorter/v3.0/product-drop-feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-wms-api-key': 'f1dc5be4-78c0-4a95-922e-c1dc5567211f',
                    'x-wms-sorter-station-id': String(STATE.stationId),
                    'x-wms-sorter-center-id': '5'
                },
                body: JSON.stringify(payload)
            });
            
            const json = await res.json();
            if (json.status && json.status !== 'OK') {
                showToast(json.message || "오류가 발생했습니다.", 'error');
                return false;
            }

            console.log("✅ Drop Feedback Sent:", payload);
            return true;
        } catch (e) {
            console.error("❌ Drop Feedback Failed:", e);
            return false;
        }
    }

    async function sendOrderFeedback(grid) {
        if (!STATE.stationId) return false;

        const order = STATE.orderPool.find(o => o.orderId === grid.assignedOrderId);
        if (!order) return false;

        const gridNo = grid.id.replace('GRID-', '').replace(/^0+/, '');

        const details = Object.keys(grid.scannedItems).map(skuBarcode => {
            let skuId = skuBarcode;
            if (order.skuInfo && order.skuInfo[skuBarcode]) {
                skuId = order.skuInfo[skuBarcode].id;
            }
            return {
                skuNo: skuId,
                sortedQuantity: grid.scannedItems[skuBarcode]
            };
        });

        const payload = {
            "containerNo": grid.destTote,
            "gridNo": gridNo,
            "orderNo": grid.assignedOrderId,
            "status": "FINISHED",
            "waveNo": STATE.workflowId,
            "stationId": String(STATE.stationId),
            "centerId": "5",
            "details": details
        };

        try {
            const res = await fetch('/api/sorter/v3.0/customer-order-feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-wms-api-key': 'f1dc5be4-78c0-4a95-922e-c1dc5567211f',
                    'x-wms-sorter-station-id': String(STATE.stationId),
                    'x-wms-sorter-center-id': '5'
                },
                body: JSON.stringify(payload)
            });

            const json = await res.json();
            if (json.status && json.status !== 'OK') {
                showToast(json.message || "오류가 발생했습니다.", 'error');
                return false;
            }

            console.log("✅ Order Feedback (FINISHED) Sent:", payload);
            return true;
        } catch (e) {
            console.error("❌ Order Feedback Failed:", e);
            return false;
        }
    }

    async function sendWaveFeedback() {
        if (!STATE.stationId || !STATE.workflowId) return false;

        const payload = {
            "waveNo": String(STATE.workflowId),
            "status": "FINISHED",
            "stationId": String(STATE.stationId),
            "centerId": "5"
        };

        try {
            const res = await fetch('/api/sorter/v3.0/wave-order-feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-wms-api-key': 'f1dc5be4-78c0-4a95-922e-c1dc5567211f',
                    'x-wms-sorter-station-id': String(STATE.stationId),
                    'x-wms-sorter-center-id': '5'
                },
                body: JSON.stringify(payload)
            });

            const json = await res.json();
            if (json.status && json.status !== 'OK') {
                showToast(json.message || "오류가 발생했습니다.", 'error');
                return false;
            }

            console.log("✅ Wave Feedback (FINISHED) Sent:", payload);
            return true;
        } catch (e) {
            console.error("❌ Wave Feedback Failed:", e);
            return false;
        }
    }

    function buildGraphQLQuery() {
        return `
            query Fc_order_assorting_station_state($barcode: String!) {
                fc_order_assorting_station_state(barcode: $barcode) {
                    station_id
                    total_cell_count
                    sorter_type
                    grids {
                        grid
                        orders {
                            order_id
                            oms_order_id
                            order_workflow_id
                            workflow_name
                            assorted_tote
                            order_item_list {
                                order_item_id
                                sku_id
                                barcode
                                total_qty
                                total_worked_qty
                                picking_tote_list {
                                    picking_tote
                                    qty
                                    worked_qty
                                }
                            }
                        }
                    }
                }
            }
        `;
    }

    function mapServerDataToState(serverData) {
        const gridCount = serverData.total_cell_count || CONFIG.GRID_COUNT;
        STATE.sorterType = serverData.sorter_type;
        STATE.stationId = serverData.station_id;
        
        // Reset workflow info
        STATE.workflowId = null;
        STATE.workflowName = null;

        const newGrids = Array(gridCount).fill(null).map((_, i) => createEmptyGrid(i + 1));
        const newOrderPool = [];
        const newToteInventory = {};

        if (serverData.grids) {
            serverData.grids.forEach(serverGrid => {
                processServerGrid(serverGrid, newGrids, newOrderPool, newToteInventory);
            });
            
            // Extract workflow info from the first order found
            for (const serverGrid of serverData.grids) {
                if (serverGrid.orders && serverGrid.orders.length > 0) {
                    const firstOrder = serverGrid.orders[0];
                    STATE.workflowId = firstOrder.order_workflow_id;
                    STATE.workflowName = firstOrder.workflow_name;
                    break;
                }
            }
        }

        STATE.grids = newGrids;
        STATE.orderPool = newOrderPool;
        STATE.toteInventory = newToteInventory;
    }

    function processServerGrid(serverGrid, newGrids, newOrderPool, newToteInventory) {
        const gridIdx = serverGrid.grid - 1;
        if (gridIdx < 0 || gridIdx >= newGrids.length) return;

        const targetGrid = newGrids[gridIdx];

        if (serverGrid.orders && serverGrid.orders.length > 0) {
            const order = serverGrid.orders[0];
            const orderData = processServerOrder(order, targetGrid, newToteInventory);
            newOrderPool.push(orderData);
        }
    }

    function processServerOrder(order, targetGrid, newToteInventory) {
        targetGrid.status = 'ACTIVE';
        targetGrid.assignedOrderId = order.order_id;

        if (order.assorted_tote) {
            targetGrid.destTote = order.assorted_tote;
            targetGrid.isVirtualTote = false;
        } else {
            targetGrid.destTote = null;
            targetGrid.isVirtualTote = false;
        }

        const requiredItems = {};
        const skuInfo = {};
        const pickingToteList = [];
        let isOrderComplete = true;

        order.order_item_list.forEach(item => {
            const sku = item.barcode || item.sku_id;
            requiredItems[sku] = item.total_qty;
            skuInfo[sku] = { id: item.sku_id, barcode: item.barcode };

            targetGrid.scannedItems[sku] = item.total_worked_qty;

            if (item.total_worked_qty < item.total_qty) {
                isOrderComplete = false;
            }

            if (item.picking_tote_list) {
                processPickingToteList(item.picking_tote_list, sku, pickingToteList, newToteInventory);
            }
        });

        if (isOrderComplete) targetGrid.status = 'COMPLETE';

        return {
            orderId: order.order_id,
            omsOrderId: order.oms_order_id,
            requiredItems: requiredItems,
            skuInfo: skuInfo,
            pickingToteList: pickingToteList,
            allocatedSlot: targetGrid.id,
            isComplete: isOrderComplete
        };
    }

    function processPickingToteList(pickingToteList, sku, outputList, toteInventory) {
        pickingToteList.forEach(pt => {
            outputList.push({
                sku: sku,
                tote: pt.picking_tote,
                qty: pt.qty,
                workedQty: pt.worked_qty
            });

            if (!toteInventory[pt.picking_tote]) {
                toteInventory[pt.picking_tote] = new Set();
            }
            toteInventory[pt.picking_tote].add(sku);
        });
    }

    // ========================================
    // 6. UI RENDERING - LOGIN SCREEN
    // ========================================
    function renderLogin() {
        const root = getRootElement();
        root.innerHTML = `
            <div class="vms-login-layer">
                <div style="font-size:50px; margin-bottom:20px;">🏗️</div>
                <div class="vms-login-card">
                    <h3>소터 작업대 바코드</h3>
                    <input id="vms-ws-id" style="width:100%; padding:10px; margin-bottom:10px; box-sizing:border-box;"
                           placeholder="WS-01" value="ASST00035">
                    <button id="vms-login-btn" style="width:100%; padding:10px; background:#3498db; color:white;
                                                      border:none; border-radius:4px; cursor:pointer;">
                        CONNECT
                    </button>
                </div>
            </div>
        `;

        attachLoginHandlers();
    }

    function attachLoginHandlers() {
        const input = document.getElementById('vms-ws-id');
        const btn = document.getElementById('vms-login-btn');

        btn.onclick = handleLogin;
        
        // Enable login via Enter key
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleLogin();
        });
    }

    async function handleLogin() {
        const barcode = document.getElementById('vms-ws-id').value.trim();
        if (!barcode) return alert("바코드를 입력하세요.");

        const btn = document.getElementById('vms-login-btn');
        const originalText = btn.innerText;
        btn.innerText = "Loading...";
        btn.disabled = true;

        try {
            const success = await fetchStationData(barcode);
            if (success) {
                STATE.workstationId = barcode;
                STATE.isLoggedIn = true;

                renderDashboard();
            }
        } catch (e) {
            console.error(e);
            alert("시스템 오류가 발생했습니다.");
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }

    // ========================================
    // 7. UI RENDERING - MAIN DASHBOARD
    // ========================================
    function renderDashboard() {
        const root = getRootElement();
        root.innerHTML = buildDashboardHTML();

        attachDashboardHandlers();
        updateAllUI();
    }

    function buildDashboardHTML() {
        return `
            <div class="vms-header" id="vms-header-bar">
                <div style="display:flex; align-items:center;">
                    <span style="font-weight:bold; font-size:16px;">🏗️ Mini Sorter</span>
                    <span id="vms-status-sub" style="font-size:12px; margin-left:15px; opacity:0.8;
                                                     background:rgba(255,255,255,0.1); padding:2px 8px;
                                                     border-radius:10px;">${STATE.workstationId}</span>
                    <span id="vms-workflow-badge" style="font-size:11px; margin-left:8px; opacity:0.9;
                                                       background:#6c5ce7; color:white; padding:2px 8px;
                                                       border-radius:4px; font-weight:bold; display:none;"></span>
                    ${!isActionAllowed() ? `<span style="background:#e74c3c; color:white; font-size:10px; padding:2px 6px; border-radius:4px; margin-left:10px; font-weight:bold;">VIEW ONLY (${STATE.sorterType})</span>` : ''}
                </div>
                <div>
                    <button id="vms-logout-btn" class="vms-ctrl-btn" title="작업대 변경">【⏻】</button>
                    <button id="vms-refresh-btn" class="vms-ctrl-btn" title="새로고침">🔄</button>
                    <button id="vms-min-btn" class="vms-ctrl-btn" title="접기/펼치기">－</button>
                    <button id="vms-close-btn" class="vms-ctrl-btn" title="닫기">✕</button>
                </div>
            </div>

            <div class="vms-body" style="flex-direction: column;">
                <div style="flex:1; display:flex; overflow:hidden;">
                    <div class="vms-sidebar">
                        <div class="vms-sidebar-head">
                            <span>Grid 현황</span>
                            <span id="vms-grid-stats">대기 중...</span>
                        </div>
                        <div id="vms-grid-list" class="vms-grid-list"></div>
                    </div>

                    <div id="vms-detail-panel" class="vms-detail">
                        ${buildEmptyStateHTML('시스템 준비 완료', '피킹 Tote를 스캔하여 작업을 시작하세요.')}
                    </div>
                </div>
            </div>

            <div id="vms-history-box" class="vms-history-log"></div>

            <div class=\"vms-footer\">
                <div class="vms-inp-grp" style="flex:0 0 250px;">
                    <label class="vms-lbl">
                        1. 피킹 Tote
                        <button id="vms-clear-tote" class="vms-clear-btn">초기화</button>
                    </label>
                    <input id="vms-src-inp" class="vms-inp" 
                           placeholder="${isActionAllowed() ? 'Tote 스캔...' : `입력 불가 (${STATE.sorterType})`}" 
                           ${isActionAllowed() ? 'autofocus' : 'disabled'}>
                </div>
                <div class="vms-inp-grp">
                    <label class="vms-lbl">2. SKU 바코드 입력</label>
                    <input id="vms-sku-inp" class="vms-inp" 
                           placeholder="${isActionAllowed() ? '대기 중...' : 'SORTER 타입만 가능'}" 
                           disabled>
                </div>
            </div>

            <div id="vms-side-panel" class="vms-side-panel ${STATE.isSidePanelOpen ? 'open' : ''}">
                <div class="vms-header" style="background: #dfe6e9; color: #2d3436; border-radius: 12px 12px 0 0; cursor: default;">
                    <span style="font-weight:bold;">🛒 피킹 토트</span>
                    <button id="vms-side-close-btn" class="vms-ctrl-btn" style="color:#2d3436;">✕</button>
                </div>
                <div id="vms-tote-list" class="vms-tote-list"></div>
            </div>

            <div id="vms-side-toggle" class="vms-side-toggle">🛒 피킹 토트</div>
        `;
    }

    function buildEmptyStateHTML(title, message) {
        const warning = !isActionAllowed()
            ? `<p style="color:#e74c3c; font-size:12px; margin-top:10px; font-weight:bold;">⚠️ 현재 ${STATE.sorterType} 타입입니다. SORTER 타입이 아니므로 현황 조회만 가능합니다.</p>`
            : '';
            
        return `
            <div class=\"vms-empty-state\">
                <h3>${title}</h3>
                <p>${message}</p>
                ${warning}
            </div>
        `;
    }

    function attachDashboardHandlers() {
        enableDragAndDrop();

        document.getElementById('vms-close-btn').onclick = handleClose;
        document.getElementById('vms-refresh-btn').onclick = handleRefresh;
        document.getElementById('vms-logout-btn').onclick = handleLogout;
        document.getElementById('vms-min-btn').onclick = handleToggleCollapse;

        document.getElementById('vms-side-toggle').onclick = handleToggleSidePanel;
        document.getElementById('vms-side-close-btn').onclick = handleToggleSidePanel;

        attachInputHandlers();
    }

    // ========================================
    // 8. UI EVENT HANDLERS
    // ========================================
    async function handleFillEmptyTotes() {
        const btn = document.getElementById('vms-fill-totes-btn');
        if (btn) btn.disabled = true;
        
        try {
            const count = await autoFillTotes();
            if (count > 0) alert(`${count}개의 그리드에 토트가 할당되었습니다.`);
            else alert("할당할 토트가 없거나 모든 그리드가 이미 채워져 있습니다.");
        } catch (e) {
            console.error(e);
            alert("토트 채우기 중 오류가 발생했습니다.");
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function autoFillTotes() {
        if (!isActionAllowed()) return 0;
        
        // Find grids that need totes
        const emptyGrids = STATE.grids.filter(g => !g.destTote || g.destTote === '-' || g.destTote === 'undefined');
        if (emptyGrids.length === 0) return 0;

        const totes = await fetchUnassignedTotes();
        if (totes.length === 0) return 0;

        let filledCount = 0;
        let toteIdx = 0;

        emptyGrids.forEach(grid => {
            if (totes[toteIdx]) {
                grid.destTote = totes[toteIdx].tote_barcode;
                grid.isVirtualTote = true;
                filledCount++;
                toteIdx++;
            }
        });

        if (filledCount > 0) updateAllUI();
        return filledCount;
    }

    async function handleRefresh() {
        const btn = document.getElementById('vms-refresh-btn');
        if (btn.disabled) return;

        const originalText = btn.innerText;
        btn.innerText = '⌛';
        btn.disabled = true;

        try {
            await fetchStationData(STATE.workstationId);
        } catch (e) {
            console.error(e);
        } finally {
            setTimeout(() => {
                btn.innerText = originalText;
                btn.disabled = false;
            }, 300);
        }
    }

    function handleClose() {
        getRootElement().remove();
    }

    function handleLogout() {
        if (!confirm("현재 작업을 종료하고 작업대를 변경하시겠습니까?")) return;

        resetState();
        renderLogin();
    }

    function resetState() {
        STATE.isLoggedIn = false;
        STATE.workstationId = null;
        STATE.sourceTote = null;
        STATE.selectedGridId = null;
        STATE.orderPool = [];
        STATE.isSidePanelOpen = true;
        initializeGrids();
    }

    function handleToggleCollapse() {
        const root = getRootElement();
        const minBtn = document.getElementById('vms-min-btn');

        STATE.isCollapsed = !STATE.isCollapsed;

        if (STATE.isCollapsed) {
            root.classList.add('collapsed');
            minBtn.innerHTML = '＋';
            document.getElementById('vms-status-sub').innerText = '축소 모드';
        } else {
            root.classList.remove('collapsed');
            minBtn.innerHTML = '－';
            document.getElementById('vms-status-sub').innerText = STATE.workstationId;
        }
    }

    function handleToggleSidePanel() {
        const panel = document.getElementById('vms-side-panel');
        STATE.isSidePanelOpen = !STATE.isSidePanelOpen;

        if (STATE.isSidePanelOpen) {
            panel.classList.add('open');
            renderSidePanel();
        } else {
            panel.classList.remove('open');
        }
    }

    // ========================================
    // 9. INPUT HANDLING
    // ========================================
    function attachInputHandlers() {
        const srcInp = document.getElementById('vms-src-inp');
        const skuInp = document.getElementById('vms-sku-inp');
        const clearBtn = document.getElementById('vms-clear-tote');

        srcInp.addEventListener('keydown', (e) => {
            handleArrowKeyNavigation(e, srcInp);
            if (e.key === 'Enter') handleToteScan(srcInp, skuInp, clearBtn);
        });

        skuInp.addEventListener('keydown', (e) => {
            handleArrowKeyNavigation(e, skuInp);
            if (e.key === 'Enter') handleSkuScan(skuInp);
        });

        clearBtn.onclick = () => handleClearTote(srcInp, skuInp, clearBtn);
    }

    function handleArrowKeyNavigation(e, input) {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            if (STATE.historyIndex > 0) {
                STATE.historyIndex--;
                input.value = STATE.scanHistory[STATE.historyIndex];
            }
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (STATE.historyIndex < STATE.scanHistory.length - 1) {
                STATE.historyIndex++;
                input.value = STATE.scanHistory[STATE.historyIndex];
            } else {
                STATE.historyIndex = STATE.scanHistory.length;
                input.value = "";
            }
        }
    }

    function handleToteScan(srcInp, skuInp, clearBtn) {
        const val = srcInp.value.trim().toUpperCase();
        if (!val) return;

        if (!isValidTote(val)) {
            alert(`⛔️ 현재 작업대 목록에 없는 Tote입니다.\n(입력값: ${val})`);
            srcInp.value = '';
            return;
        }

        addToHistory(val);
        activateTote(val, srcInp, skuInp, clearBtn);
        showToteActivatedMessage(val);
        updateAllUI();
        handleRefresh();
    }

    function isValidTote(toteId) {
        return STATE.toteInventory && STATE.toteInventory[toteId];
    }

    function activateTote(toteId, srcInp, skuInp, clearBtn) {
        STATE.sourceTote = toteId;
        srcInp.disabled = true;
        clearBtn.style.display = 'inline-block';

        skuInp.disabled = false;
        skuInp.placeholder = "SKU 스캔...";
        skuInp.focus();
    }

    function showToteActivatedMessage(toteId) {
        const panel = document.getElementById('vms-detail-panel');
        if (panel) {
            panel.innerHTML = `
                <div class="vms-empty-state">
                    <h2 style="color:#3498db;">${toteId}</h2>
                    <p>피킹 Tote가 확인되었습니다.</p>
                    <p style="font-size:12px; color:#999; margin-top:5px;">상품을 스캔하여 분류하세요.</p>
                </div>
            `;
        }
    }

    function handleClearTote(srcInp, skuInp, clearBtn) {
        STATE.sourceTote = null;

        srcInp.disabled = false;
        srcInp.value = '';
        srcInp.focus();
        clearBtn.style.display = 'none';

        skuInp.disabled = true;
        skuInp.value = '';
        skuInp.placeholder = "대기 중...";

        updateAllUI();
        showSystemReadyMessage();
    }

    function showSystemReadyMessage() {
        const panel = document.getElementById('vms-detail-panel');
        if (panel) {
            panel.innerHTML = buildEmptyStateHTML('시스템 준비 완료', '피킹 Tote를 스캔하여 작업을 시작하세요.');
        }
    }

    function handleSkuScan(skuInp) {
        const sku = skuInp.value.trim().toUpperCase();
        skuInp.value = '';
        if (!sku) return;

        if (!isValidSkuForCurrentTote(sku)) {
            alert(`⛔️ 현재 Tote [${STATE.sourceTote}]에 존재하지 않는 상품입니다.\n(입력값: ${sku})`);
            return;
        }

        addToHistory(sku);
        processSorting(sku);
        handleRefresh();
    }

    function isValidSkuForCurrentTote(sku) {
        const validSkusInTote = STATE.toteInventory[STATE.sourceTote];
        return validSkusInTote && validSkusInTote.has(sku);
    }

    // ========================================
    // 10. HISTORY MANAGEMENT
    // ========================================
    function addToHistory(code) {
        STATE.scanHistory.push(code);
        if (STATE.scanHistory.length > CONFIG.MAX_HISTORY_SIZE) {
            STATE.scanHistory.shift();
        }
        STATE.historyIndex = STATE.scanHistory.length;
        renderHistory();
    }

    function renderHistory() {
        const box = document.getElementById('vms-history-box');
        if (!box) return;

        box.innerHTML = STATE.scanHistory
            .map(h => `<div class="vms-history-item" onclick="document.getElementById('vms-sku-inp').value='${h}'; document.getElementById('vms-sku-inp').focus();">${h}</div>`)
            .reverse()
            .join('');
    }

    // ========================================
    // 11. SORTING LOGIC (Core Business Logic)
    // ========================================
    async function processSorting(sku) {
        let targetGrid = findExistingGridForSku(sku);

        if (!targetGrid) {
            targetGrid = allocateNewGridForSku(sku);
        }

        if (targetGrid) {
            updateGridWithScan(targetGrid, sku);
            selectGrid(targetGrid.id);
            scrollToGrid(targetGrid.id);

            // Call Feedback API and then refresh
            try {
                showLoading(); // Show loading indicator
                
                // 1. Product Drop Feedback
                const dropSuccess = await sendDropFeedback(targetGrid, sku);
                if (!dropSuccess) {
                     // If failed, sync with server to rollback optimistic UI updates
                    await fetchStationData(STATE.workstationId);
                    return;
                }
                
                // 2. Customer Order Feedback (If grid complete)
                if (checkIfGridComplete(targetGrid)) {
                    const orderSuccess = await sendOrderFeedback(targetGrid);
                    if (!orderSuccess) {
                         // If order feedback failed, we still might want to refresh to reflect drop success?
                         // But usually if this fails, we should probably stop.
                         await fetchStationData(STATE.workstationId);
                         return;
                    }

                    showToast(`✅ Grid [${targetGrid.id}] 분류 완료!`, 'grid-complete');
                    
                    // 3. Wave Order Feedback (If all orders in wave complete)
                    if (checkIfWaveComplete()) {
                        await sendWaveFeedback();
                        showToast(`🎉 모든 분류 작업이 완료되었습니다!`, 'wave-complete');
                    }
                }

                await fetchStationData(STATE.workstationId);

                // 4. Auto-clear tote if all items in tote are sorted
                if (checkIfToteComplete()) {
                    // Slight delay to allow user to see the last scan result
                    setTimeout(() => {
                        const srcInp = document.getElementById('vms-src-inp');
                        const skuInp = document.getElementById('vms-sku-inp');
                        const clearBtn = document.getElementById('vms-clear-tote');
                        handleClearTote(srcInp, skuInp, clearBtn);
                    }, 500);
                }

            } catch (e) {
                console.error("Sorting Process Error:", e);
                alert("처리 중 오류가 발생했습니다.");
            } finally {
                hideLoading(); // Hide loading indicator
            }
        } else {
            alert(`해당 SKU가 필요한 주문이 없습니다: ${sku}`);
        }
    }

    function checkIfGridComplete(grid) {
        const order = STATE.orderPool.find(o => o.orderId === grid.assignedOrderId);
        if (!order) return false;

        for (const sku in order.requiredItems) {
            const req = order.requiredItems[sku];
            const scn = grid.scannedItems[sku] || 0;
            if (scn < req) return false;
        }
        return true;
    }

    function checkIfWaveComplete() {
        if (!STATE.orderPool || STATE.orderPool.length === 0) return false;

        return STATE.orderPool.every(order => {
            if (order.isComplete) return true;
            
            const grid = STATE.grids.find(g => g.assignedOrderId === order.orderId);
            if (!grid) return false; 
            
            return checkIfGridComplete(grid);
        });
    }

    function checkIfToteComplete() {
        if (!STATE.sourceTote) return false;

        let isToteComplete = true;

        for (const order of STATE.orderPool) {
            if (!order.pickingToteList) continue;

            const itemsInTote = order.pickingToteList.filter(pt => pt.tote === STATE.sourceTote);
            
            for (const item of itemsInTote) {
                if (item.workedQty < item.qty) {
                    isToteComplete = false;
                    break;
                }
            }
            if (!isToteComplete) break;
        }

        return isToteComplete;
    }

    function findExistingGridForSku(sku) {
        return STATE.grids.find(grid => {
            if (grid.status !== 'ACTIVE') return false;

            const order = STATE.orderPool.find(o => o.orderId === grid.assignedOrderId);
            const scanned = grid.scannedItems[sku] || 0;
            const required = order.requiredItems[sku] || 0;

            return scanned < required;
        });
    }

    function allocateNewGridForSku(sku) {
        const candidateOrder = STATE.orderPool.find(o =>
            !o.allocatedSlot && !o.isComplete && (o.requiredItems[sku] > 0)
        );

        if (!candidateOrder) return null;

        const emptyGrid = STATE.grids.find(g => g.status === 'EMPTY');
        if (!emptyGrid) {
            alert("모든 Grid가 사용 중입니다!");
            return null;
        }

        emptyGrid.status = 'ACTIVE';
        emptyGrid.assignedOrderId = candidateOrder.orderId;
        emptyGrid.destTote = ''; // No mock tote ID
        candidateOrder.allocatedSlot = emptyGrid.id;

        return emptyGrid;
    }

    function updateGridWithScan(grid, sku) {
        grid.scannedItems[sku] = (grid.scannedItems[sku] || 0) + 1;
        grid.logs.unshift({
            time: new Date().toLocaleTimeString('ko-KR'),
            sku: sku
        });
    }

    function scrollToGrid(gridId) {
        const card = [...document.querySelectorAll('.vms-card')]
            .find(el => el.innerText.includes(gridId));
        if (card) {
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    // ========================================
    // 12. UI UPDATE FUNCTIONS
    // ========================================
    function showLoading() {
        const root = getRootElement();
        if (!root.querySelector('.vms-loading-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'vms-loading-overlay';
            overlay.innerHTML = '<span>⏳ Processing...</span>';
            root.appendChild(overlay);
        }
    }

    function hideLoading() {
        const root = getRootElement();
        const overlay = root.querySelector('.vms-loading-overlay');
        if (overlay) overlay.remove();
    }

    function showToast(message, type = 'grid-complete') {
        const root = getRootElement();
        if (!root) return;

        let container = root.querySelector('#vms-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'vms-toast-container';
            container.className = 'vms-toast-container';
            root.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `vms-toast ${type}`;
        toast.innerText = message;

        container.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            toast.style.transition = 'all 0.3s ease-in';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function updateAllUI() {
        updateGridList();
        updateHeaderStatus();
        renderSidePanel();
        if (STATE.selectedGridId) {
            renderGridDetail(STATE.selectedGridId);
        }
    }

    function updateGridList() {
        const list = document.getElementById('vms-grid-list');
        if (!list) return;

        list.innerHTML = '';

        const stats = { active: 0, empty: 0 };
        STATE.grids.forEach(grid => {
            const card = createGridCard(grid, stats);
            list.appendChild(card);
        });

        updateGridStats(stats);
    }

    function createGridCard(grid, stats) {
        const card = document.createElement('div');
        card.onclick = () => selectGrid(grid.id);

        if (grid.status === 'EMPTY') {
            stats.empty++;
            card.className = `vms-card empty ${STATE.selectedGridId === grid.id ? 'selected' : ''}`;
            
            // Show tote info if assigned (even if empty)
            if (grid.destTote && grid.destTote !== '-') {
                const toteHtml = grid.isVirtualTote 
                    ? `<span class="vms-card-dest editable" 
                            style="background:#f8f9fa; color:#495057; border:1px dashed #ced4da; padding:4px 8px; border-radius:4px; font-size:12px; font-weight:bold; display:inline-flex; align-items:center; gap:4px; opacity:0.7;"
                            onclick="event.stopPropagation(); window.vmsChangeTote('${grid.id}')"
                            title="클릭하여 토트 변경">
                            <span style="font-size:14px;">⏳</span> ${grid.destTote}
                       </span>`
                    : `<span class="vms-card-dest">${grid.destTote}</span>`;

                card.innerHTML = `
                    <div class="vms-card-header">
                        <span class="vms-card-id" style="font-weight:normal;">${grid.id}</span>
                        <div style="text-align:right;">${toteHtml}</div>
                    </div>
                    <div style="display:flex; justify-content:center; align-items:center; height:40px; color:#bdc3c7; font-size:12px;">
                        주문 대기 중
                    </div>
                `;
            } else {
                // Original empty state
                card.innerHTML = `
                    <span class="vms-card-id" style="font-weight:normal;">${grid.id}</span>
                    <span class="vms-empty-tag">사용 가능</span>
                `;
            }
        } else {
            stats.active++;
            card.className = `vms-card active ${grid.status === 'COMPLETE' ? 'completed' : ''} ${STATE.selectedGridId === grid.id ? 'selected' : ''}`;
            card.innerHTML = buildActiveGridCardHTML(grid);
        }

        return card;
    }

    function buildActiveGridCardHTML(grid) {
        const order = STATE.orderPool.find(o => o.orderId === grid.assignedOrderId);
        const totalQty = Object.values(order.requiredItems).reduce((a, b) => a + b, 0);
        const currentQty = Object.values(grid.scannedItems).reduce((a, b) => a + b, 0);
        const percent = Math.min(100, (currentQty / totalQty) * 100);
        const isFull = currentQty >= totalQty;

        const toteDisplay = grid.destTote || '<span style="color:#eee">No Tote</span>';
        
        // Editable handling for virtual totes
        let toteHtml = '';
        if (grid.isVirtualTote) {
            toteHtml = `
                <span class="vms-card-dest editable" 
                      style="background:#f8f9fa; color:#495057; border:1px dashed #ced4da; padding:4px 8px; border-radius:4px; font-size:12px; font-weight:bold; display:inline-flex; align-items:center; gap:4px; opacity:0.7;"
                      onclick="event.stopPropagation(); window.vmsChangeTote('${grid.id}')"
                      title="클릭하여 토트 변경">
                    <span style="font-size:14px;">⏳</span> ${toteDisplay}
                </span>
            `;
        } else {
             toteHtml = `<span class="vms-card-dest" style="color:#d63031; font-weight:bold; font-size:14px;">${toteDisplay}</span>`;
        }

        return `
            <div class="vms-card-header">
                <span class="vms-card-id">${grid.id}</span>
                <div style="text-align:right;">${toteHtml}</div>
            </div>
            <div style="font-size:11px; color:#636e72; margin-bottom:5px;">
                물류접수번호: ${order.omsOrderId}<br>
                <span style="font-size:10px; color:#b2bec3;">(ORDER_ID: ${order.orderId})</span>
            </div>
            <div class="vms-progress-bar">
                <div class="vms-progress-fill" style="width:${percent}%; background:${isFull ? '#2ecc71' : '#3498db'}"></div>
            </div>
            <div class="vms-progress-text">${currentQty} / ${totalQty}</div>
        `;
    }

    function updateGridStats(stats) {
        const statsEl = document.getElementById('vms-grid-stats');
        if (statsEl) {
            statsEl.innerText = `${stats.active}개 활성 / ${stats.empty}개 대기`;
        }
    }

    function updateHeaderStatus() {
        const statusSub = document.getElementById('vms-status-sub');
        const workflowBadge = document.getElementById('vms-workflow-badge');

        if (statusSub && !STATE.isCollapsed) {
            const toteIndicator = STATE.sourceTote
                ? ` ▶ <span style="color:#ffeaa7;">${STATE.sourceTote}</span>`
                : '';
            statusSub.innerHTML = `${STATE.workstationId}${toteIndicator}`;
        }

        if (workflowBadge && !STATE.isCollapsed) {
            if (STATE.workflowName) {
                workflowBadge.innerText = `차수: ${STATE.workflowName} (orderWorkflowId: ${STATE.workflowId})`;
                workflowBadge.style.display = 'inline-block';
            } else {
                workflowBadge.style.display = 'none';
            }
        }
    }

    function selectGrid(id) {
        STATE.selectedGridId = id;
        updateGridList();
        renderGridDetail(id);
    }

    // ========================================
    // 13. GRID DETAIL RENDERING
    // ========================================
    function renderGridDetail(gridId) {
        const panel = document.getElementById('vms-detail-panel');
        if (!panel) return;

        const grid = STATE.grids.find(g => g.id === gridId);

        if (grid.status === 'EMPTY') {
            panel.innerHTML = buildEmptyGridDetailHTML(grid);
        } else {
            panel.innerHTML = buildActiveGridDetailHTML(grid);
        }
    }

    function buildEmptyGridDetailHTML(grid) {
        return `
            <div class="vms-empty-state">
                <h2 style="color:#bdc3c7; font-size:40px; margin-bottom:20px;">${grid.id}</h2>
                <h3 style="color:#7f8c8d;">사용 가능한 Grid</h3>
                <p>새 상품을 스캔하면 이 Grid가 사용됩니다.</p>
            </div>
        `;
    }

    function buildActiveGridDetailHTML(grid) {
        const order = STATE.orderPool.find(o => o.orderId === grid.assignedOrderId);
        
        const toteColor = grid.isVirtualTote ? '#95a5a6' : '#d63031';
        const toteLabel = grid.isVirtualTote ? '(가할당)' : '';
        const toteDisplay = grid.destTote || '-';
        
        // Add change button only for virtual totes
        const changeBtn = grid.isVirtualTote 
            ? `<button onclick="window.vmsChangeTote('${grid.id}')" style="cursor:pointer; border:1px solid #bdc3c7; background:#fff; border-radius:4px; font-size:11px; color:#636e72; padding:2px 6px; margin-left:5px;">✏️변경</button>` 
            : '';

        return `
            <div class="vms-detail-top">
                <span style="font-size:28px; font-weight:bold; color:#2c3e50;">${grid.id}</span>
                <span style="background:#6c5ce7; color:#fff; padding:4px 8px; border-radius:4px;
                             margin-left:10px; font-size:12px;">물류접수번호: ${order.omsOrderId} (ORDER_ID: ${order.orderId})</span>
                <div style="margin-top:10px; font-size:14px;">
                    분류 Tote: <b style="color:${toteColor}; font-size:18px;">${toteDisplay}</b> 
                    <span style="font-size:12px; color:#7f8c8d;">${toteLabel}</span>
                    ${changeBtn}
                </div>
            </div>
            <div class="vms-sku-grid" style="display:flex; flex-direction:column; gap:20px;">
                ${buildSkuTable(order, grid)}
                ${buildPickingToteTable(order)}
            </div>
        `;
    }

    function buildSkuTable(order, grid) {
        const allSkus = new Set([...Object.keys(order.requiredItems), ...Object.keys(grid.scannedItems)]);
        let rows = '';

        allSkus.forEach(sku => {
            const req = order.requiredItems[sku] || 0;
            const scn = grid.scannedItems[sku] || 0;
            const isDone = scn >= req;
            const info = order.skuInfo[sku] || { id: sku, barcode: '-' };

            rows += `
                <tr class="${isDone ? 'done' : ''}" style="border-bottom: 1px solid #f9f9f9;
                                                             ${isDone ? 'color:#2ecc71; font-weight:bold;' : ''}">
                    <td style="padding:8px 0;">${info.id}</td>
                    <td style="color:#7f8c8d; font-size:11px;">${info.barcode}</td>
                    <td style="text-align:right;">${scn} / ${req}</td>
                </tr>
            `;
        });

        return `
            <div class="vms-box">
                <h4 style="margin:0 0 10px 0; color:#999;">주문 SKU (BOM)</h4>
                <table style="width:100%; font-size:12px; border-collapse:collapse;">
                    <thead style="text-align:left; color:#bdc3c7; border-bottom:1px solid #eee;">
                        <tr>
                            <th style="padding-bottom:5px; font-weight:normal;">SKU ID</th>
                            <th style="padding-bottom:5px; font-weight:normal;">바코드</th>
                            <th style="padding-bottom:5px; font-weight:normal; text-align:right;">수량</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    function buildPickingToteTable(order) {
        let toteRows = '';

        if (order.pickingToteList) {
            order.pickingToteList.forEach(pt => {
                const isDone = pt.workedQty >= pt.qty;
                const isCurrentSource = STATE.sourceTote === pt.tote;
                const info = order.skuInfo[pt.sku] || { id: pt.sku, barcode: '-' };

                toteRows += `
                    <tr class="${isDone ? 'done' : ''}" 
                        style="border-bottom: 1px solid #f9f9f9; ${isCurrentSource ? 'background:rgba(253, 203, 110, 0.1);' : ''} ${isDone ? 'color:#2ecc71; font-weight:bold;' : ''}">
                        <td style="padding:8px 0; font-weight:${isCurrentSource ? 'bold' : 'normal'};">${pt.tote}</td>
                        <td style="color:#7f8c8d; font-size:11px;">${info.id}</td>
                        <td style="color:#7f8c8d; font-size:11px;">${info.barcode}</td>
                        <td style="text-align:right;">${pt.workedQty} / ${pt.qty}</td>
                    </tr>
                `;
            });
        }

        return `
            <div class="vms-box">
                <h4 style="margin:0 0 10px 0; color:#999;">대상 피킹 Tote</h4>
                <table style="width:100%; font-size:12px; border-collapse:collapse;">
                    <thead style="text-align:left; color:#bdc3c7; border-bottom:1px solid #eee;">
                        <tr>
                            <th style="padding-bottom:5px; font-weight:normal;">Tote</th>
                            <th style="padding-bottom:5px; font-weight:normal;">SKU ID</th>
                            <th style="padding-bottom:5px; font-weight:normal;">바코드</th>
                            <th style="padding-bottom:5px; font-weight:normal; text-align:right;">수량</th>
                        </tr>
                    </thead>
                    <tbody>${toteRows || '<tr><td colspan="4" style="text-align:center; color:#ccc; padding:10px;">정보 없음</td></tr>'}</tbody>
                </table>
            </div>
        `;
    }



    // ========================================
    // 14. TOTE LIST RENDERING
    // ========================================
    function renderSidePanel() {
        if (!STATE.isSidePanelOpen) return;

        const list = document.getElementById('vms-tote-list');
        if (!list) return;

        list.innerHTML = '';

        if (!STATE.toteInventory || Object.keys(STATE.toteInventory).length === 0) {
            list.innerHTML = '<div style="text-align:center; padding:20px; color:#bdc3c7;">할당된 Tote가 없습니다.</div>';
            return;
        }

        Object.keys(STATE.toteInventory).sort().forEach(toteId => {
            const card = createToteCard(toteId, STATE.toteInventory[toteId]);
            list.appendChild(card);
        });
    }

    function createToteCard(toteId, skuSet) {
        const card = document.createElement('div');
        card.className = 'vms-tote-card';

        const skuRows = Array.from(skuSet).map(sku => {
            // Find SKU Info & Quantity
            let info = { id: sku, barcode: sku };
            let totalQty = 0;
            let totalWorkedQty = 0;

            for(const order of STATE.orderPool) {
                // Check if this SKU is in this tote for this order
                if (order.skuInfo[sku]) {
                    info = order.skuInfo[sku];
                }
                
                // Calculate quantity in this tote for this SKU
                const pickingItems = order.pickingToteList.filter(pt => pt.tote === toteId && pt.sku === sku);
                pickingItems.forEach(pt => {
                    totalQty += pt.qty;
                    totalWorkedQty += pt.workedQty;
                });
            }

            const isDone = totalWorkedQty >= totalQty;
            const rowStyle = isDone ? 'color:#2ecc71; text-decoration:line-through; opacity:0.7;' : 'color:#636e72;';
            const qtyStyle = isDone ? 'color:#2ecc71; font-weight:bold;' : 'color:#2d3436; font-weight:bold;';

            return `
                <div class="vms-sku-row" style="${rowStyle}">
                    <span class="vms-sku-code" style="flex:1; ${isDone ? 'color:#2ecc71;' : ''}" title="${info.barcode}">${info.barcode}</span>
                    <span style="flex:1; text-align:center;">${info.id}</span>
                    <span style="width:50px; text-align:right; ${qtyStyle}">${totalWorkedQty} / ${totalQty}</span>
                </div>
            `;
        }).join('');

        card.innerHTML = `
            <div class="vms-tote-header">
                <span>${toteId}</span>
                <span style="background:#dfe6e9; padding:2px 6px; border-radius:10px; font-size:11px; font-weight:normal;">${skuSet.size} SKUs</span>
            </div>
            <div style="font-size:10px; color:#b2bec3; display:flex; padding:4px 0; border-bottom:1px solid #eee; margin-bottom:5px;">
                <span style="flex:1;">Barcode</span>
                <span style="flex:1; text-align:center;">SKU ID</span>
                <span style="width:50px; text-align:right;">Done/Qty</span>
            </div>
            <div>${skuRows}</div>
        `;

        return card;
    }
    // 15. DRAG & DROP FUNCTIONALITY
    // ========================================
    let dragState = {
        isDragging: false,
        offset: { x: 0, y: 0 }
    };

    function enableDragAndDrop() {
        const root = getRootElement();
        const header = document.getElementById('vms-header-bar');

        header.addEventListener('mousedown', (e) => {
            // Allow text selection on specific elements by preventing drag start
            if (['BUTTON', 'INPUT', 'SPAN', 'P', 'DIV'].includes(e.target.tagName) && e.target !== header) return;

            dragState.isDragging = true;
            const rect = root.getBoundingClientRect();
            dragState.offset.x = e.clientX - rect.left;
            dragState.offset.y = e.clientY - rect.top;
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragState.isDragging) return;

            root.style.left = (e.clientX - dragState.offset.x) + 'px';
            root.style.top = (e.clientY - dragState.offset.y) + 'px';
        });

        window.addEventListener('mouseup', () => {
            dragState.isDragging = false;
        });
    }

    // ========================================
    // 16. STYLES INJECTION
    // ========================================
    function injectStyles() {
        if (document.getElementById(CONFIG.STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = CONFIG.STYLE_ID;
        style.textContent = getStylesheet();
        document.head.appendChild(style);
    }

    function getStylesheet() {
        return `
            #vms-rebin-fixed-root {
                position: fixed; top: 100px; left: 100px;
                width: 1100px; height: 750px;
                background: #f4f6f8; border: 1px solid #bdc3c7;
                box-shadow: 0 10px 40px rgba(0,0,0,0.4);
                border-radius: 12px; z-index: 99999;
                display: flex; flex-direction: column; overflow: visible;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            #vms-rebin-fixed-root.collapsed {
                height: 55px !important;
                width: 350px !important;
                border: 2px solid #34495e;
            }
            #vms-rebin-fixed-root.collapsed .vms-body,
            #vms-rebin-fixed-root.collapsed .vms-footer,
            #vms-rebin-fixed-root.collapsed .vms-side-panel,
            #vms-rebin-fixed-root.collapsed .vms-side-toggle {
                display: none;
            }

            .vms-header {
                height: 55px; background: #2d3436; color: #fff;
                display: flex; align-items: center; padding: 0 15px; justify-content: space-between;
                border-radius: 12px 12px 0 0;
            }
            .vms-header:active { cursor: grabbing; }

            .vms-ctrl-btn {
                background: none; border: none; color: #bdc3c7;
                font-size: 18px; cursor: pointer; padding: 0 8px; font-weight: bold;
            }
            .vms-ctrl-btn:hover { color: #fff; }

            /* Side Panel for 피킹 토트 */
            .vms-side-panel {
                position: absolute; top: 0; left: 100%;
                width: 320px; height: 100%;
                background: #fff; border: 1px solid #bdc3c7;
                box-shadow: 5px 5px 20px rgba(0,0,0,0.1);
                border-radius: 12px; margin-left: 15px;
                display: flex; flex-direction: column;
                transition: opacity 0.3s, transform 0.3s;
                opacity: 0; transform: translateX(-20px); pointer-events: none;
                z-index: 99990;
            }
            .vms-side-panel.open {
                opacity: 1; transform: translateX(0); pointer-events: auto;
            }

            /* Tote List Styles */
            .vms-tote-list { flex: 1; overflow-y: auto; padding: 15px; background: #f4f6f8; border-radius: 0 0 12px 12px; }
            .vms-tote-card {
                background: #fff; border-radius: 8px; padding: 12px; margin-bottom: 10px;
                border: 1px solid #dfe6e9; box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            .vms-tote-header { font-weight: bold; font-size: 14px; color: #2d3436; margin-bottom: 8px; display:flex; justify-content:space-between; }
            .vms-sku-row { display: flex; justify-content: space-between; font-size: 11px; padding: 4px 0; border-bottom: 1px dashed #eee; color: #636e72; }
            .vms-sku-row:last-child { border-bottom: none; }
            .vms-sku-code { font-family: monospace; color: #0984e3; }

            .vms-login-layer {
                position: absolute; inset:0; background:#2c3e50; z-index:10;
                display:flex; justify-content:center; align-items:center;
                color:#fff; flex-direction:column;
            }
            .vms-login-card {
                background:#fff; padding:30px; border-radius:8px;
                width:300px; color:#333; text-align:center;
            }

            /* Side Toggle Button (IntelliJ Style) */
            .vms-side-toggle {
                position: absolute; top: 100px; right: -28px;
                width: 28px; height: 120px;
                background: #2d3436; color: #bdc3c7;
                border-radius: 0 8px 8px 0;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; z-index: 99900;
                writing-mode: vertical-rl;
                font-size: 12px; letter-spacing: 1px;
                box-shadow: 2px 2px 5px rgba(0,0,0,0.2);
                transition: background 0.2s, right 0.3s;
            }
            .vms-side-toggle:hover { background: #636e72; color: #fff; }
            
            /* Hide toggle when panel is open */
            .vms-side-panel.open ~ .vms-side-toggle {
                display: none;
            }

            .vms-body { flex: 1; display: flex; overflow: hidden; }
            .vms-sidebar {
                width: 380px; background: #dfe6e9; border-right: 1px solid #b2bec3;
                display: flex; flex-direction: column;
            }
            .vms-sidebar-head {
                padding: 12px; background: #b2bec3; font-weight: bold;
                color: #2d3436; font-size: 13px; display:flex; justify-content:space-between;
            }
            .vms-grid-list { flex: 1; overflow-y: auto; padding: 10px; }

            .vms-card {
                border-radius: 6px; padding: 12px; margin-bottom: 8px;
                cursor: pointer; transition: all 0.2s; position: relative; min-height: 50px;
            }
            .vms-card:hover { transform: translateY(-2px); }
            .vms-card.empty {
                background: #f1f2f6; border: 2px dashed #b2bec3; opacity: 0.8;
                color: #95a5a6; display: flex; align-items: center; justify-content: space-between;
            }
            .vms-card.active {
                background: #fff; border: 2px solid #fff;
                box-shadow: 0 2px 5px rgba(0,0,0,0.05);
            }
            .vms-card.active.selected { border-color: #3498db; background: #f0fbff; }
            .vms-card.completed { background: #e0fff0; border: 2px solid #2ecc71; opacity: 0.9; }

            .vms-card-header { display: flex; justify-content: space-between; margin-bottom: 5px; }
            .vms-card-id { font-weight: bold; font-size: 14px; color: #636e72; }
            .vms-card-dest { font-weight: bold; color: #d63031; font-size: 14px; }
            .vms-card-dest.editable:hover { background: #dfe6e9; color: #2d3436; border-color: #95a5a6; }
            .vms-progress-bar {
                height: 6px; background: #eee; border-radius: 3px;
                overflow: hidden; margin-top: 8px;
            }
            .vms-progress-fill {
                height: 100%; background: #3498db; width: 0%; transition: width 0.3s;
            }
            .vms-progress-text {
                font-size: 11px; color: #666; text-align: right; margin-top: 2px;
            }

            .vms-detail {
                flex: 1; padding: 30px; background: #fff;
                display: flex; flex-direction: column; overflow-y: auto;
            }
            .vms-empty-state { text-align:center; color:#ccc; margin-top:150px; }
            .vms-detail-top {
                border-bottom: 2px solid #f1f2f6;
                padding-bottom: 20px; margin-bottom: 20px;
            }
            .vms-sku-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .vms-box { border: 1px solid #eee; border-radius: 8px; padding: 15px; }
            .vms-item-row {
                display: flex; justify-content: space-between;
                padding: 8px 0; border-bottom: 1px dashed #eee; font-size: 13px;
            }
            .vms-item-row.done { color: #2ecc71; font-weight: bold; }

            .vms-footer {
                height: 80px; background: #fff; border-top: 1px solid #ddd;
                display: flex; align-items: center; padding: 0 30px; gap: 20px;
                border-radius: 0 0 12px 12px;
            }
            .vms-inp-grp { flex:1; display:flex; flex-direction:column; }
            .vms-lbl {
                font-size:11px; font-weight:bold; color:#aaa; margin-bottom:5px;
                display:flex; justify-content:space-between; align-items:center;
            }
            .vms-inp {
                padding:12px; border:2px solid #ddd; border-radius:6px;
                font-size:16px; outline:none;
            }
            .vms-inp:focus { border-color:#3498db; }

            .vms-history-log {
                height: 100px; background: #2d3436; color: #dfe6e9;
                overflow-y: auto; padding: 10px; font-family: monospace; font-size: 12px;
                border-top: 1px solid #b2bec3; display: flex; flex-direction: column-reverse;
            }
            .vms-history-item {
                padding: 2px 0; border-bottom: 1px solid #636e72; cursor: pointer;
            }
            .vms-history-item:hover { color: #fff; }
            .vms-clear-btn {
                background: #e74c3c; color: white; border: none; border-radius: 4px;
                padding: 2px 8px; cursor: pointer; font-size: 10px; display: none;
            }

            .vms-loading-overlay {
                position: absolute; inset: 0; background: rgba(255, 255, 255, 0.7);
                display: flex; justify-content: center; align-items: center;
                z-index: 1000; font-size: 24px; color: #3498db; font-weight: bold;
                border-radius: 12px;
            }

            /* Toast Notifications */
            .vms-toast-container {
                position: absolute; top: 65px; right: 20px; z-index: 100000;
                display: flex; flex-direction: column; gap: 10px; pointer-events: none;
            }
            .vms-toast {
                padding: 12px 20px; border-radius: 8px; color: #fff; font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-size: 14px;
                animation: vms-slide-in 0.3s ease-out forwards;
                opacity: 0; transform: translateX(100%);
                pointer-events: auto; min-width: 200px;
            }
            @keyframes vms-slide-in {
                to { opacity: 1; transform: translateX(0); }
            }
            .vms-toast.grid-complete {
                background: #2ecc71; border-left: 5px solid #27ae60;
            }
            .vms-toast.wave-complete {
                background: #8e44ad; border-left: 5px solid #fff;
                font-size: 16px; padding: 15px 25px;
            }
            .vms-toast.error {
                background: #e74c3c; border-left: 5px solid #c0392b;
            }
        `;
    }

    // ========================================
    // 17. ENTRY POINT
    // ========================================
    
    // Expose function for inline onclick handler
    window.vmsChangeTote = function(gridId) {
        if (!isActionAllowed()) {
            alert("조회 전용 모드에서는 토트를 변경할 수 없습니다.");
            return;
        }

        const grid = STATE.grids.find(g => g.id === gridId);
        if (!grid || !grid.isVirtualTote) {
            alert("변경할 수 없는 토트입니다.");
            return;
        }

        const newTote = prompt(`[${gridId}] 변경할 토트 바코드를 입력하세요:`, grid.destTote);
        if (newTote && newTote.trim() !== "") {
            // Check for duplicates in other grids
            const duplicate = STATE.grids.find(g => g.destTote === newTote.trim() && g.id !== gridId);
            if (duplicate) {
                alert(`이미 다른 그리드(${duplicate.id})에서 사용 중인 토트입니다.`);
                return;
            }

            grid.destTote = newTote.trim();
            updateAllUI();
        }
    };

    init();

})();