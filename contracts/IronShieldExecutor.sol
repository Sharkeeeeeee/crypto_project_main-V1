// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================
//  IronShield Atomic Arbitrage Executor
//  Flash Loan Receiver + Multi-DEX Swap Router
//  Security: checkProfit modifier ensures ZERO principal loss
// ============================================================

import "./interfaces/IAavePool.sol";
import "./interfaces/IERC20Minimal.sol";

/**
 * @title IronShieldExecutor
 * @notice Executes atomic flash loan arbitrage on Base chain
 * @dev Implements Aave V3 IFlashLoanSimpleReceiver
 *      All execution paths MUST end with profit > 0 or revert
 */
contract IronShieldExecutor {
    // ── State Variables ──────────────────────────────────────
    address public immutable owner;
    address public immutable aavePool;
    address public immutable weth;

    // Known DEX routers on Base
    address public constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address public constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // Minimum profit threshold in wei (configurable)
    uint256 public minProfitWei;

    // Emergency pause
    bool public paused;

    // Token blacklist (honeypot protection)
    mapping(address => bool) public blacklisted;

    // Execution statistics
    uint256 public totalExecutions;
    uint256 public totalProfit;

    // ── Events ───────────────────────────────────────────────
    event ArbitrageExecuted(
        address indexed token,
        uint256 loanAmount,
        uint256 profit,
        uint256 gasUsed,
        uint256 timestamp
    );
    event TokenBlacklisted(address indexed token, string reason);
    event ProfitWithdrawn(address indexed to, uint256 amount);
    event MinProfitUpdated(uint256 oldValue, uint256 newValue);
    event EmergencyPause(bool paused);

    // ── Errors ───────────────────────────────────────────────
    error Unauthorized();
    error InsufficientProfit(uint256 expected, uint256 actual);
    error TokenIsBlacklisted(address token);
    error ContractPaused();
    error InvalidSwapTarget();
    error SwapFailed(uint8 stepIndex);

    // ── Modifiers ────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    /**
     * @dev Critical safety modifier - ensures profit after execution
     * @param token The base token being arbitraged
     */
    modifier checkProfit(address token, uint256 loanAmount, uint256 premium) {
        uint256 initialBalance = IERC20Minimal(token).balanceOf(address(this));
        _;
        uint256 finalBalance = IERC20Minimal(token).balanceOf(address(this));
        uint256 totalOwed = loanAmount + premium;

        // HARD REQUIREMENT: Must have enough to repay AND profit
        if (finalBalance < initialBalance + totalOwed + minProfitWei) {
            revert InsufficientProfit(
                initialBalance + totalOwed + minProfitWei,
                finalBalance
            );
        }
    }

    // ── Constructor ──────────────────────────────────────────
    constructor(address _aavePool, address _weth, uint256 _minProfitWei) {
        owner = msg.sender;
        aavePool = _aavePool;
        weth = _weth;
        minProfitWei = _minProfitWei;
    }

    // ══════════════════════════════════════════════════════════
    //  FLASH LOAN ENTRY POINT
    // ══════════════════════════════════════════════════════════

    /**
     * @notice Initiates a flash loan and executes arbitrage
     * @param asset The token to borrow (e.g., WETH)
     * @param amount The amount to borrow
     * @param swapData Encoded swap steps for multi-hop arbitrage
     */
    function initiateArbitrage(
        address asset,
        uint256 amount,
        bytes calldata swapData
    ) external onlyOwner whenNotPaused {
        // Request flash loan from Aave V3
        IAavePool(aavePool).flashLoanSimple(
            address(this),      // receiver
            asset,              // asset to borrow
            amount,             // amount
            swapData,           // params (forwarded to executeOperation)
            0                   // referral code
        );
    }

    /**
     * @notice Aave V3 flash loan callback
     * @dev Called by Aave Pool after funds are transferred
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    )
        external
        checkProfit(asset, amount, premium)
        returns (bool)
    {
        // Security: Only Aave Pool can call this
        require(msg.sender == aavePool, "Caller not Aave Pool");
        require(initiator == address(this), "Invalid initiator");

        uint256 gasStart = gasleft();

        // Decode and execute swap steps
        _executeSwapSteps(asset, amount, params);

        // Approve Aave Pool to pull repayment (loan + premium)
        uint256 totalOwed = amount + premium;
        IERC20Minimal(asset).approve(aavePool, totalOwed);

        // Calculate and log profit
        uint256 gasUsed = gasStart - gasleft();
        uint256 profit = IERC20Minimal(asset).balanceOf(address(this)) - totalOwed;

        totalExecutions++;
        totalProfit += profit;

        emit ArbitrageExecuted(asset, amount, profit, gasUsed, block.timestamp);

        return true;
    }

    // ══════════════════════════════════════════════════════════
    //  SWAP EXECUTION ENGINE
    // ══════════════════════════════════════════════════════════

    /**
     * @dev Swap step structure for multi-hop arbitrage
     * dexId: 0 = Aerodrome, 1 = Uniswap V3, 2 = BaseSwap, 3 = Custom
     */
    struct SwapStep {
        uint8 dexId;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;      // 0 = use full balance
        uint24 fee;            // Uniswap V3 fee tier (500, 3000, 10000)
        bytes extraData;       // DEX-specific parameters
    }

    function _executeSwapSteps(
        address /* baseAsset */,
        uint256 /* loanAmount */,
        bytes calldata params
    ) internal {
        SwapStep[] memory steps = abi.decode(params, (SwapStep[]));

        for (uint8 i = 0; i < steps.length; i++) {
            SwapStep memory step = steps[i];

            // Honeypot protection
            if (blacklisted[step.tokenIn] || blacklisted[step.tokenOut]) {
                revert TokenIsBlacklisted(
                    blacklisted[step.tokenIn] ? step.tokenIn : step.tokenOut
                );
            }

            // Determine input amount
            uint256 inputAmount = step.amountIn == 0
                ? IERC20Minimal(step.tokenIn).balanceOf(address(this))
                : step.amountIn;

            bool success;
            if (step.dexId == 0) {
                success = _swapAerodrome(step.tokenIn, step.tokenOut, inputAmount, step.extraData);
            } else if (step.dexId == 1) {
                success = _swapUniswapV3(step.tokenIn, step.tokenOut, inputAmount, step.fee);
            } else if (step.dexId == 2) {
                success = _swapBaseSwap(step.tokenIn, step.tokenOut, inputAmount, step.extraData);
            } else if (step.dexId == 3) {
                success = _swapCustom(step.tokenIn, step.tokenOut, inputAmount, step.extraData);
            }

            if (!success) revert SwapFailed(i);
        }
    }

    // ── Aerodrome Swap ───────────────────────────────────────
    function _swapAerodrome(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes memory extraData
    ) internal returns (bool) {
        // Decode Aerodrome-specific params (stable vs volatile pool)
        bool stable = extraData.length > 0 && abi.decode(extraData, (bool));

        IERC20Minimal(tokenIn).approve(AERODROME_ROUTER, amountIn);

        // Build route
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: tokenIn,
            to: tokenOut,
            stable: stable,
            factory: address(0) // Use default factory
        });

        try IAerodromeRouter(AERODROME_ROUTER).swapExactTokensForTokens(
            amountIn,
            0, // minAmountOut = 0 (profit check handles safety)
            routes,
            address(this),
            block.timestamp
        ) returns (uint256[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    // ── Uniswap V3 Swap ─────────────────────────────────────
    function _swapUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal returns (bool) {
        IERC20Minimal(tokenIn).approve(UNISWAP_V3_ROUTER, amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });

        try ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(params) returns (
            uint256
        ) {
            return true;
        } catch {
            return false;
        }
    }

    // ── BaseSwap Swap (UniV2 fork) ───────────────────────────
    function _swapBaseSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes memory /* extraData */
    ) internal returns (bool) {
        address BASESWAP_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;

        IERC20Minimal(tokenIn).approve(BASESWAP_ROUTER, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        try IUniswapV2Router(BASESWAP_ROUTER).swapExactTokensForTokens(
            amountIn,
            0,
            path,
            address(this),
            block.timestamp
        ) returns (uint256[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    // ── Custom DEX Swap (low-level call) ─────────────────────
    function _swapCustom(
        address tokenIn,
        address /* tokenOut */,
        uint256 amountIn,
        bytes memory extraData
    ) internal returns (bool) {
        // extraData = abi.encode(targetRouter, callData)
        (address target, bytes memory callData) = abi.decode(
            extraData,
            (address, bytes)
        );

        // Safety: prevent calling token contracts directly
        if (target == tokenIn) revert InvalidSwapTarget();

        IERC20Minimal(tokenIn).approve(target, amountIn);

        (bool success, ) = target.call(callData);
        return success;
    }

    // ══════════════════════════════════════════════════════════
    //  ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════

    function blacklistToken(address token, string calldata reason) external onlyOwner {
        blacklisted[token] = true;
        emit TokenBlacklisted(token, reason);
    }

    function removeBlacklist(address token) external onlyOwner {
        blacklisted[token] = false;
    }

    function setMinProfit(uint256 _minProfitWei) external onlyOwner {
        emit MinProfitUpdated(minProfitWei, _minProfitWei);
        minProfitWei = _minProfitWei;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit EmergencyPause(_paused);
    }

    /**
     * @notice Withdraw accumulated profits
     * @dev Only withdraws ERC20 tokens, not ETH
     */
    function withdrawProfit(address token, uint256 amount) external onlyOwner {
        IERC20Minimal(token).transfer(owner, amount);
        emit ProfitWithdrawn(owner, amount);
    }

    function withdrawETH() external onlyOwner {
        (bool success, ) = owner.call{value: address(this).balance}("");
        require(success, "ETH withdrawal failed");
    }

    // Allow receiving ETH
    receive() external payable {}
}

// ── Interface Stubs (inline for compilation) ─────────────────

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
