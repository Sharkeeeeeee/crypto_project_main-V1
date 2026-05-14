// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================
//  🛡️ IronShield Atomic Arbitrage Executor v3.1 — Production
//  Flash Loan Receiver + Multi-DEX Swap Router
//
//  [v3.1 UPGRADE] 核心升級：
//    1. 拔除全域 minProfitWei，改為 Per-Call 動態校驗
//    2. 引入 SafeERC20 確保非標代幣 (USDT) 相容性
//    3. 動態餘額讀取防禦 Fee-on-Transfer (交易稅) 代幣
//    4. EIP-1153 瞬態存儲重入鎖 (Gas 優化)
// ============================================================

import "./interfaces/IAavePool.sol";
import "./interfaces/IERC20Minimal.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IronShieldExecutor
 * @notice 在 Base 鏈上執行原子閃電貸套利（Cancun 硬分叉優化版）
 */
contract IronShieldExecutor {
    using SafeERC20 for IERC20;

    // ── 狀態變數 ──────────────────────────────────────────────
    address public immutable owner;
    address public immutable aavePool;
    address public immutable weth;

    // 常量地址 (Base Chain)
    address public constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address public constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address public constant BASESWAP_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;

    bool public paused;
    mapping(address => bool) public blacklisted;

    uint256 public totalExecutions;
    uint256 public totalProfit;

    // [v3.1 UPGRADE] EIP-1153 瞬態存儲插槽 (Transient Storage)
    bytes32 private constant _REENTRANCY_SLOT =
        0x8e94fed44239eb2314ab7a27a24d9e8a0a8e8b8c5c2d6e9f1a3b5c7d9e0f1a2b;

    // ── 事件 ──────────────────────────────────────────────────
    event ArbitrageExecuted(
        address indexed token, 
        uint256 loanAmount,
        uint256 profit, 
        uint256 gasUsed, 
        uint256 timestamp
    );
    event TokenBlacklisted(address indexed token, string reason);
    event ProfitWithdrawn(address indexed to, uint256 amount);
    event EmergencyPause(bool paused);

    // ── 錯誤定義 ──────────────────────────────────────────────
    error Unauthorized();
    error InsufficientProfit(uint256 expected, uint256 actual);
    error TokenIsBlacklisted(address token);
    error ContractPaused();
    error InvalidSwapTarget();
    error SwapFailed(uint8 stepIndex);
    error TransactionTooOld();
    error ReentrancyGuardLocked();

    // ── 修飾器 ────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    /**
     * @dev [v3.1 UPGRADE] 使用 EIP-1153 TSTORE/TLOAD 實現極低成本重入鎖
     */
    modifier nonReentrant() {
        assembly {
            if tload(_REENTRANCY_SLOT) {
                mstore(0x00, 0x37ed32e8) // ReentrancyGuardLocked()
                revert(0x1c, 0x04)
            }
            tstore(_REENTRANCY_SLOT, 1)
        }
        _;
        assembly {
            tstore(_REENTRANCY_SLOT, 0)
        }
    }

    /**
     * @dev [v3.1 UPGRADE] 獲利校驗修飾器
     * 解析 Per-Call 的 minProfit 並進行精確餘額對比
     */
    modifier checkProfit(address token, uint256 premium, bytes calldata params) {
        uint256 initialBalance = IERC20(token).balanceOf(address(this));
        
        // 解析 minProfit (params 的第一個 uint256)
        (uint256 minProfit, , ) = abi.decode(params, (uint256, uint256, bytes));
        
        _;
        
        uint256 finalBalance = IERC20(token).balanceOf(address(this));
        uint256 requiredBalance = initialBalance + premium + minProfit;
        
        if (finalBalance < requiredBalance) {
            revert InsufficientProfit(requiredBalance, finalBalance);
        }
    }

    constructor(address _aavePool, address _weth) {
        owner = msg.sender;
        aavePool = _aavePool;
        weth = _weth;
    }

    // ══════════════════════════════════════════════════════════
    //  入口函數：發起套利
    // ══════════════════════════════════════════════════════════

    /**
     * @notice 發起閃電貸並執行多步交換
     * @param asset     借貸資產地址
     * @param amount    借貸數量
     * @param minProfit 要求的最低利潤 (對應資產精度)
     * @param deadline  交易截止時間
     * @param swapData  編碼後的 SwapSteps 陣列
     */
    function initiateArbitrage(
        address asset,
        uint256 amount,
        uint256 minProfit,
        uint256 deadline,
        bytes calldata swapData
    ) external onlyOwner whenNotPaused nonReentrant {
        if (block.timestamp > deadline) revert TransactionTooOld();

        // [v3.1 UPGRADE] 打包 minProfit 至回調參數中
        bytes memory params = abi.encode(minProfit, deadline, swapData);
        
        IAavePool(aavePool).flashLoanSimple(
            address(this), 
            asset, 
            amount, 
            params, 
            0
        );
    }

    /**
     * @dev Aave V3 回調函數
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    )
        external
        checkProfit(asset, premium, params)
        returns (bool)
    {
        require(msg.sender == aavePool, "Caller not Aave Pool");
        require(initiator == address(this), "Invalid initiator");

        uint256 gasStart = gasleft();

        // 解析參數
        (, uint256 deadline, bytes memory swapData) = abi.decode(params, (uint256, uint256, bytes));

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        // 執行 Swap 鏈
        _executeSwapSteps(deadline, swapData);

        // [v3.1 UPGRADE] 使用 SafeERC20 forceApprove 處理 Aave 還款
        uint256 totalOwed = amount + premium;
        IERC20(asset).forceApprove(aavePool, totalOwed);

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        
        uint256 profit;
        unchecked {
            if (balanceAfter > balanceBefore + premium) {
                profit = balanceAfter - balanceBefore - premium;
                totalProfit += profit;
            }
            totalExecutions++;
        }

        emit ArbitrageExecuted(asset, amount, profit, gasStart - gasleft(), block.timestamp);
        return true;
    }

    // ══════════════════════════════════════════════════════════
    //  交換引擎
    // ══════════════════════════════════════════════════════════

    struct SwapStep {
        uint8 dexId;      // 0: Aero, 1: UniV3, 2: BaseSwap, 3: Custom
        address tokenIn;
        address tokenOut;
        uint256 amountIn; // 0 = 使用全額餘額
        uint24 fee;       // 僅 UniV3 使用
        bytes extraData;
    }

    /**
     * @dev 執行多步交換邏輯
     */
    function _executeSwapSteps(
        uint256 deadline,
        bytes memory swapData
    ) internal {
        SwapStep[] memory steps = abi.decode(swapData, (SwapStep[]));

        for (uint8 i = 0; i < steps.length; i++) {
            SwapStep memory step = steps[i];

            if (blacklisted[step.tokenIn] || blacklisted[step.tokenOut]) {
                revert TokenIsBlacklisted(
                    blacklisted[step.tokenIn] ? step.tokenIn : step.tokenOut
                );
            }

            // [v3.1 UPGRADE] 動態餘額讀取：防禦 Fee-on-Transfer 代幣
            // 第 0 步：使用指定金額 (若為0則讀全額)
            // 第 1+ 步：強制讀取實際餘額，防止因交易稅導致的金額不一致
            uint256 inputAmount;
            if (i == 0) {
                inputAmount = step.amountIn == 0
                    ? IERC20(step.tokenIn).balanceOf(address(this))
                    : step.amountIn;
            } else {
                inputAmount = IERC20(step.tokenIn).balanceOf(address(this));
            }

            if (inputAmount == 0) revert SwapFailed(i);

            bool success;
            if (step.dexId == 0) {
                success = _swapAerodrome(step.tokenIn, step.tokenOut, inputAmount, deadline, step.extraData);
            } else if (step.dexId == 1) {
                success = _swapUniswapV3(step.tokenIn, step.tokenOut, inputAmount, step.fee, deadline);
            } else if (step.dexId == 2) {
                success = _swapBaseSwap(step.tokenIn, step.tokenOut, inputAmount, deadline);
            } else if (step.dexId == 3) {
                success = _swapCustom(step.tokenIn, inputAmount, step.extraData);
            }

            if (!success) revert SwapFailed(i);
        }
    }

    // ── 各 DEX 實作 (使用 SafeERC20 / forceApprove) ──────────────

    function _swapAerodrome(
        address tokenIn, address tokenOut,
        uint256 amountIn, uint256 deadline,
        bytes memory extraData
    ) internal returns (bool) {
        bool stable = extraData.length > 0 && abi.decode(extraData, (bool));
        IERC20(tokenIn).forceApprove(AERODROME_ROUTER, amountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: tokenIn, to: tokenOut, stable: stable, factory: address(0)
        });

        try IAerodromeRouter(AERODROME_ROUTER).swapExactTokensForTokens(
            amountIn, 0, routes, address(this), deadline
        ) returns (uint256[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    function _swapUniswapV3(
        address tokenIn, address tokenOut,
        uint256 amountIn, uint24 fee, uint256 deadline
    ) internal returns (bool) {
        IERC20(tokenIn).forceApprove(UNISWAP_V3_ROUTER, amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        try ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(params) returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _swapBaseSwap(
        address tokenIn, address tokenOut,
        uint256 amountIn, uint256 deadline
    ) internal returns (bool) {
        IERC20(tokenIn).forceApprove(BASESWAP_ROUTER, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        try IUniswapV2Router(BASESWAP_ROUTER).swapExactTokensForTokens(
            amountIn, 0, path, address(this), deadline
        ) returns (uint256[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    function _swapCustom(
        address tokenIn, uint256 amountIn, bytes memory extraData
    ) internal returns (bool) {
        (address target, bytes memory callData) = abi.decode(extraData, (address, bytes));
        if (target == tokenIn) revert InvalidSwapTarget();

        IERC20(tokenIn).forceApprove(target, amountIn);
        (bool success, ) = target.call(callData);
        return success;
    }

    // ── 管理函數 ──────────────────────────────────────────────

    function blacklistToken(address token, string calldata reason) external onlyOwner {
        blacklisted[token] = true;
        emit TokenBlacklisted(token, reason);
    }

    function removeBlacklist(address token) external onlyOwner {
        blacklisted[token] = false;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit EmergencyPause(_paused);
    }

    function withdrawProfit(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
        emit ProfitWithdrawn(owner, amount);
    }

    function withdrawETH() external onlyOwner {
        (bool success, ) = owner.call{value: address(this).balance}("");
        require(success, "ETH withdrawal failed");
    }

    receive() external payable {}
}

// ── 介面定義 ────────────────────────────────────────────────

interface IAerodromeRouter {
    struct Route { address from; address to; bool stable; address factory; }
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

interface ISwapRouter {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}
