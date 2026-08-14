// aspi/server.js

import "dotenv/config";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { timingSafeEqual } from "node:crypto";

// ======================================================
// APP
// ======================================================

const app = express();

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

app.disable("x-powered-by");

// ======================================================
// CORS - TEMPORALMENTE ABIERTO PARA TODOS
// ======================================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(
  express.json({
    limit: "50kb",
    strict: true,
  }),
);

// ======================================================
// VARIABLES DE ENTORNO
// ======================================================

const RPC_URL = process.env.MAINNET_RPC_URL?.trim();
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS?.trim();

const EXPECTED_CHAIN_ID = process.env.EXPECTED_CHAIN_ID
  ? BigInt(process.env.EXPECTED_CHAIN_ID)
  : null;

const EXPLORER_BASE_URL =
  process.env.EXPLORER_BASE_URL?.replace(/\/$/, "") || null;

const ADMIN_API_KEY = process.env.ADMIN_API_KEY?.trim();

// ======================================================
// ABI DONATION WALLET
// ======================================================

const DONATION_WALLET_ABI = [
  "function usdcToken() view returns (address)",
  "function owner() view returns (address)",
  "function getContractBalance() view returns (uint256)",
  "function getDonorBalance(address donor) view returns (uint256)",
  "function calculateRequiredDonation(address donor) view returns (uint256)",
  "function getDonorStats(address donor) view returns (uint256 total, uint256 count)",

  "function processDonation(address donor, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (bool)",

  "function withdrawDonations(address to, uint256 amount)",
  "function withdrawAll()",

  "event DonationReceived(address indexed donor, uint256 amount, uint256 donorBalanceAfter, uint256 timestamp)",
  "event DonationFailed(address indexed donor, bytes32 indexed nonce, string reason)",
  "event FundsWithdrawn(address indexed owner, uint256 amount)",
];

// ======================================================
// ABI ERC20 / USDC
// ======================================================

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

// ======================================================
// ESTADO BLOCKCHAIN
// ======================================================

let blockchain = null;
let initializationPromise = null;

// ======================================================
// ERROR PERSONALIZADO
// ======================================================

class AppError extends Error {
  constructor(
    message,
    statusCode = 500,
    code = "INTERNAL_ERROR",
    details = null,
  ) {
    super(message);

    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}


// ======================================================
// AUTENTICACIÓN ADMIN PARA RETIROS
// ======================================================

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

function requireAdmin(req, res, next) {
  try {
    if (!ADMIN_API_KEY) {
      throw new AppError(
        "ADMIN_API_KEY no está configurada en el backend",
        503,
        "ADMIN_AUTH_NOT_CONFIGURED",
      );
    }

    const authorization = req.get("authorization") || "";
    const bearerPrefix = "Bearer ";

    const bearerKey = authorization.startsWith(bearerPrefix)
      ? authorization.slice(bearerPrefix.length).trim()
      : "";

    const headerKey = (req.get("x-admin-key") || "").trim();
    const providedKey = bearerKey || headerKey;

    if (!providedKey || !constantTimeEquals(providedKey, ADMIN_API_KEY)) {
      throw new AppError(
        "No autorizado",
        401,
        "UNAUTHORIZED",
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}

function assertBackendIsOwner(ctx) {
  if (ctx.signerAddress.toLowerCase() !== ctx.owner.toLowerCase()) {
    throw new AppError(
      "La PRIVATE_KEY del backend no corresponde al owner() del contrato",
      403,
      "BACKEND_NOT_OWNER",
    );
  }
}

function parseTokenAmount(value, decimals, fieldName = "amount") {
  if (value === null || value === undefined || value === "") {
    throw new AppError(
      `Falta el campo ${fieldName}`,
      400,
      "MISSING_FIELD",
    );
  }

  if (typeof value !== "string" && typeof value !== "number") {
    throw new AppError(
      `${fieldName} debe ser string o number`,
      400,
      "INVALID_AMOUNT",
    );
  }

  const normalized = String(value).trim();

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new AppError(
      `${fieldName} debe ser una cantidad decimal positiva`,
      400,
      "INVALID_AMOUNT",
    );
  }

  let parsed;

  try {
    parsed = ethers.parseUnits(normalized, decimals);
  } catch {
    throw new AppError(
      `${fieldName} tiene demasiados decimales o un formato inválido`,
      400,
      "INVALID_AMOUNT",
    );
  }

  if (parsed <= 0n) {
    throw new AppError(
      `${fieldName} debe ser mayor que cero`,
      400,
      "INVALID_AMOUNT",
    );
  }

  return parsed;
}

function addGasMargin(estimatedGas, percentage = 20n) {
  return (estimatedGas * (100n + percentage) + 99n) / 100n;
}

// ======================================================
// ASYNC HANDLER
// ======================================================

function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ======================================================
// VALIDAR VARIABLES DE ENTORNO
// ======================================================

function validateEnvironment() {
  const missing = [];

  if (!RPC_URL) {
    missing.push("MAINNET_RPC_URL");
  }

  if (!PRIVATE_KEY) {
    missing.push("PRIVATE_KEY");
  }

  if (!CONTRACT_ADDRESS) {
    missing.push("CONTRACT_ADDRESS");
  }

  if (missing.length > 0) {
    throw new AppError(
      `Faltan variables de entorno: ${missing.join(", ")}`,
      503,
      "MISSING_ENV",
    );
  }

  if (!ethers.isAddress(CONTRACT_ADDRESS)) {
    throw new AppError(
      "CONTRACT_ADDRESS no es una dirección Ethereum válida",
      503,
      "INVALID_CONTRACT_ADDRESS",
    );
  }

  try {
    new ethers.Wallet(PRIVATE_KEY);
  } catch {
    throw new AppError(
      "PRIVATE_KEY tiene un formato inválido",
      503,
      "INVALID_PRIVATE_KEY",
    );
  }
}

// ======================================================
// VALIDAR ADDRESS
// ======================================================

function validateAddress(address, fieldName = "address") {
  if (typeof address !== "string" || !ethers.isAddress(address)) {
    throw new AppError(
      `${fieldName} no es una dirección Ethereum válida`,
      400,
      "INVALID_ADDRESS",
    );
  }

  return ethers.getAddress(address);
}

// ======================================================
// VALIDAR BYTES32
// ======================================================

function validateBytes32(value, fieldName) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new AppError(
      `${fieldName} debe ser bytes32 (0x + 64 caracteres hexadecimales)`,
      400,
      "INVALID_BYTES32",
    );
  }

  return value;
}

// ======================================================
// PARSEAR UINT256
// ======================================================

function parseUnsignedInteger(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    throw new AppError(`Falta el campo ${fieldName}`, 400, "MISSING_FIELD");
  }

  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new AppError(
      `${fieldName} debe enviarse como string para evitar pérdida de precisión`,
      400,
      "UNSAFE_INTEGER",
    );
  }

  let parsed;

  try {
    parsed = BigInt(value);
  } catch {
    throw new AppError(
      `${fieldName} debe ser un entero válido`,
      400,
      "INVALID_INTEGER",
    );
  }

  if (parsed < 0n) {
    throw new AppError(
      `${fieldName} no puede ser negativo`,
      400,
      "INVALID_INTEGER",
    );
  }

  return parsed;
}

// ======================================================
// VALIDAR V
// ======================================================

function validateSignatureV(value) {
  const parsed = parseUnsignedInteger(value, "v");

  // Algunas wallets devuelven 0/1
  if (parsed === 0n) {
    return 27;
  }

  if (parsed === 1n) {
    return 28;
  }

  if (parsed === 27n || parsed === 28n) {
    return Number(parsed);
  }

  throw new AppError("v debe ser 0, 1, 27 o 28", 400, "INVALID_SIGNATURE_V");
}

// ======================================================
// OBTENER MENSAJE DE ERROR
// ======================================================

function getErrorMessage(error) {
  if (!error) {
    return "Error desconocido";
  }

  return (
    error.shortMessage ||
    error.reason ||
    error.info?.error?.message ||
    error.error?.message ||
    error.message ||
    "Error blockchain desconocido"
  );
}

// ======================================================
// OBTENER REVERT REASON
// ======================================================

function getRevertReason(error) {
  return (
    error?.reason ||
    error?.revert?.args?.[0] ||
    error?.info?.error?.message ||
    error?.error?.message ||
    error?.shortMessage ||
    null
  );
}

// ======================================================
// EXPLORER
// ======================================================

function getExplorerUrl(chainId, txHash) {
  if (EXPLORER_BASE_URL) {
    return `${EXPLORER_BASE_URL}/tx/${txHash}`;
  }

  const explorers = {
    // Ethereum
    1: "https://etherscan.io",
    11155111: "https://sepolia.etherscan.io",

    // Polygon
    137: "https://polygonscan.com",
    80002: "https://amoy.polygonscan.com",

    // Base
    8453: "https://basescan.org",
    84532: "https://sepolia.basescan.org",

    // Arbitrum
    42161: "https://arbiscan.io",

    // Optimism
    10: "https://optimistic.etherscan.io",

    // BSC
    56: "https://bscscan.com",
  };

  const explorer = explorers[chainId.toString()];

  if (!explorer) {
    return null;
  }

  return `${explorer}/tx/${txHash}`;
}

// ======================================================
// INICIALIZAR BLOCKCHAIN
// ======================================================

async function initializeBlockchain() {
  validateEnvironment();

  console.log("🔌 Inicializando blockchain...");

  // ----------------------------------------------------
  // PROVIDER
  // ----------------------------------------------------

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // ----------------------------------------------------
  // NETWORK
  // ----------------------------------------------------

  const network = await provider.getNetwork();

  console.log(`🌐 RPC conectado a chainId: ${network.chainId}`);

  if (EXPECTED_CHAIN_ID !== null && network.chainId !== EXPECTED_CHAIN_ID) {
    throw new AppError(
      `RPC conectado a chainId ${network.chainId}, pero se esperaba ${EXPECTED_CHAIN_ID}`,
      503,
      "WRONG_NETWORK",
    );
  }

  // ----------------------------------------------------
  // COMPROBAR CONTRATO
  // ----------------------------------------------------

  const contractCode = await provider.getCode(CONTRACT_ADDRESS);

  if (!contractCode || contractCode === "0x") {
    throw new AppError(
      `No existe contrato desplegado en ${CONTRACT_ADDRESS} para chainId ${network.chainId}`,
      503,
      "CONTRACT_NOT_DEPLOYED",
    );
  }

  // ----------------------------------------------------
  // WALLET
  // ----------------------------------------------------

  const ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // ----------------------------------------------------
  // CONTRATO READ
  // ----------------------------------------------------

  const readContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    DONATION_WALLET_ABI,
    provider,
  );

  // ----------------------------------------------------
  // CONTRATO WRITE
  // ----------------------------------------------------

  const writeContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    DONATION_WALLET_ABI,
    ownerWallet,
  );

  // ----------------------------------------------------
  // OBTENER USDC Y OWNER
  // ----------------------------------------------------

  const [usdcAddressRaw, ownerRaw] = await Promise.all([
    readContract.usdcToken(),
    readContract.owner(),
  ]);

  const usdcAddress = validateAddress(usdcAddressRaw, "usdcToken");

  const owner = validateAddress(ownerRaw, "owner");

  // ----------------------------------------------------
  // COMPROBAR USDC
  // ----------------------------------------------------

  const usdcCode = await provider.getCode(usdcAddress);

  if (!usdcCode || usdcCode === "0x") {
    throw new AppError(
      `usdcToken() apunta a una dirección sin contrato: ${usdcAddress}`,
      503,
      "INVALID_USDC_CONTRACT",
    );
  }

  // ----------------------------------------------------
  // CONTRATO USDC
  // ----------------------------------------------------

  const usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  // ----------------------------------------------------
  // INFORMACIÓN TOKEN
  // ----------------------------------------------------

  const [decimals, name, symbol] = await Promise.all([
    usdcContract.decimals(),

    usdcContract.name().catch(() => "USD Coin"),

    usdcContract.symbol().catch(() => "USDC"),
  ]);

  const usdcDecimals = Number(decimals);

  if (
    !Number.isInteger(usdcDecimals) ||
    usdcDecimals < 0 ||
    usdcDecimals > 255
  ) {
    throw new AppError(
      "El token devuelve decimals inválidos",
      503,
      "INVALID_TOKEN_DECIMALS",
    );
  }

  const signerAddress = ownerWallet.address;

  // ----------------------------------------------------
  // LOGS
  // ----------------------------------------------------

  console.log("======================================");
  console.log("✅ BLOCKCHAIN INICIALIZADA");
  console.log("======================================");

  console.log(`🌐 Chain ID: ${network.chainId}`);

  console.log(`📜 DonationWallet: ${CONTRACT_ADDRESS}`);

  console.log(`💵 Token: ${symbol}`);

  console.log(`💵 Token address: ${usdcAddress}`);

  console.log(`💵 Decimals: ${usdcDecimals}`);

  console.log(`👑 Owner contrato: ${owner}`);

  console.log(`🔐 Backend signer: ${signerAddress}`);

  // ----------------------------------------------------
  // COMPROBAR OWNER
  // ----------------------------------------------------

  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    console.warn(
      "⚠️ ADVERTENCIA: PRIVATE_KEY no corresponde al owner() del contrato",
    );
  } else {
    console.log("✅ Backend signer coincide con owner()");
  }

  console.log("======================================");

  // ----------------------------------------------------
  // RETORNAR CONTEXTO
  // ----------------------------------------------------

  return {
    provider,

    network,

    chainId: network.chainId,

    ownerWallet,

    readContract,

    writeContract,

    owner,

    signerAddress,

    usdcAddress,

    usdcContract,

    usdcDecimals,

    tokenName: name,

    tokenSymbol: symbol,
  };
}

// ======================================================
// GET BLOCKCHAIN
// ======================================================

async function getBlockchain() {
  if (blockchain) {
    return blockchain;
  }

  /*
   * Esto evita que si entran 10 requests al mismo tiempo
   * inicialicemos 10 providers/contratos.
   */
  if (!initializationPromise) {
    initializationPromise = initializeBlockchain()
      .then((result) => {
        blockchain = result;

        return result;
      })
      .catch((error) => {
        /*
         * Si RPC falla temporalmente no guardamos
         * para siempre una promise rechazada.
         */

        initializationPromise = null;

        throw error;
      });
  }

  return initializationPromise;
}

// ======================================================
// ROOT
// ======================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Donation Wallet API",
    status: "running",
    cors: "open",
  });
});

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/api/health",

  asyncHandler(async (req, res) => {
    try {
      const ctx = await getBlockchain();

      const blockNumber = await ctx.provider.getBlockNumber();

      return res.status(200).json({
        success: true,

        status: "healthy",

        blockchain: {
          connected: true,

          chainId: ctx.chainId.toString(),

          blockNumber,
        },
      });
    } catch (error) {
      return res.status(503).json({
        success: false,

        status: "unhealthy",

        blockchain: {
          connected: false,
        },

        error: getErrorMessage(error),
      });
    }
  }),
);

// ======================================================
// API INFO
// ======================================================

app.get(
  "/api/info",

  asyncHandler(async (req, res) => {
    const ctx = await getBlockchain();

    const [contractBalance, nativeBalance, blockNumber] = await Promise.all([
      ctx.readContract.getContractBalance(),

      ctx.provider.getBalance(ctx.signerAddress),

      ctx.provider.getBlockNumber(),
    ]);

    return res.status(200).json({
      success: true,

      network: {
        chainId: ctx.chainId.toString(),

        blockNumber,
      },

      contract: {
        address: CONTRACT_ADDRESS,

        owner: ctx.owner,

        backendSigner: ctx.signerAddress,

        signerIsOwner:
          ctx.signerAddress.toLowerCase() === ctx.owner.toLowerCase(),
      },

      token: {
        address: ctx.usdcAddress,

        name: ctx.tokenName,

        symbol: ctx.tokenSymbol,

        decimals: ctx.usdcDecimals,
      },

      balances: {
        contractRaw: contractBalance.toString(),

        contractFormatted: ethers.formatUnits(
          contractBalance,
          ctx.usdcDecimals,
        ),

        signerNative: ethers.formatEther(nativeBalance),
      },
    });
  }),
);

// ======================================================
// BALANCE
// ======================================================

app.get(
  "/api/balance/:address",

  asyncHandler(async (req, res) => {
    const address = validateAddress(req.params.address);

    const ctx = await getBlockchain();

    // --------------------------------------------------
    // OBTENER BALANCES
    // --------------------------------------------------

    const [balance, donorBalance] = await Promise.all([
      ctx.usdcContract.balanceOf(address),

      ctx.readContract.getDonorBalance(address),
    ]);

    // --------------------------------------------------
    // CALCULAR DONACIÓN
    // --------------------------------------------------

    let donationAmount = null;
    let donationError = null;

    try {
      donationAmount = await ctx.readContract.calculateRequiredDonation(
        address,
      );
    } catch (error) {
      donationError = {
        code: error.code || "CALCULATION_REVERTED",

        message:
          getRevertReason(error) ||
          "No fue posible calcular la donación requerida",
      };
    }

    // --------------------------------------------------
    // RESPUESTA
    // --------------------------------------------------

    return res.status(200).json({
      success: true,

      address,

      token: {
        symbol: ctx.tokenSymbol,

        decimals: ctx.usdcDecimals,
      },

      walletBalance: {
        raw: balance.toString(),

        formatted: ethers.formatUnits(balance, ctx.usdcDecimals),
      },

      donorBalance: {
        raw: donorBalance.toString(),

        formatted: ethers.formatUnits(donorBalance, ctx.usdcDecimals),
      },

      requiredDonation:
        donationAmount !== null
          ? {
              raw: donationAmount.toString(),

              formatted: ethers.formatUnits(donationAmount, ctx.usdcDecimals),
            }
          : null,

      donationError,
    });
  }),
);

// ======================================================
// DONOR STATS
// ======================================================

app.get(
  "/api/donor/:address",

  asyncHandler(async (req, res) => {
    const address = validateAddress(req.params.address);

    const ctx = await getBlockchain();

    const [total, count] = await ctx.readContract.getDonorStats(address);

    return res.status(200).json({
      success: true,

      address,

      totalDonated: {
        raw: total.toString(),

        formatted: ethers.formatUnits(total, ctx.usdcDecimals),
      },

      donationCount: count.toString(),
    });
  }),
);

// ======================================================
// DONATE
// ======================================================

app.post(
  "/api/donate",

  asyncHandler(async (req, res) => {
    const { donor, amount, validAfter, validBefore, nonce, v, r, s } =
      req.body || {};

    // ==================================================
    // VALIDACIONES
    // ==================================================

    const normalizedDonor = validateAddress(donor, "donor");

    const parsedAmount = parseUnsignedInteger(amount, "amount");

    const parsedValidAfter = parseUnsignedInteger(validAfter, "validAfter");

    const parsedValidBefore = parseUnsignedInteger(validBefore, "validBefore");

    if (parsedAmount === 0n) {
      throw new AppError(
        "amount debe ser mayor que cero",
        400,
        "INVALID_AMOUNT",
      );
    }

    if (parsedValidBefore <= parsedValidAfter) {
      throw new AppError(
        "validBefore debe ser mayor que validAfter",
        400,
        "INVALID_VALIDITY_WINDOW",
      );
    }

    const normalizedNonce = validateBytes32(nonce, "nonce");

    const normalizedR = validateBytes32(r, "r");

    const normalizedS = validateBytes32(s, "s");

    const normalizedV = validateSignatureV(v);

    // ==================================================
    // BLOCKCHAIN
    // ==================================================

    const ctx = await getBlockchain();

    console.log("======================================");

    console.log("📥 NUEVA SOLICITUD DE DONACIÓN");

    console.log(`👤 Donor: ${normalizedDonor}`);

    console.log(`💰 Amount raw: ${parsedAmount}`);

    console.log(
      `💰 Amount: ${ethers.formatUnits(parsedAmount, ctx.usdcDecimals)} ${
        ctx.tokenSymbol
      }`,
    );

    // ==================================================
    // STATIC CALL
    // ==================================================

    /*
     * Simulamos primero.
     *
     * Si el contrato va a hacer revert, detenemos
     * la operación antes de gastar gas.
     */

    try {
      await ctx.writeContract.processDonation.staticCall(
        normalizedDonor,
        parsedAmount,
        parsedValidAfter,
        parsedValidBefore,
        normalizedNonce,
        normalizedV,
        normalizedR,
        normalizedS,
      );

      console.log("✅ Simulación correcta");
    } catch (error) {
      console.error("❌ Simulación fallida:", getErrorMessage(error));

      throw new AppError(
        getRevertReason(error) ||
          "La transacción sería rechazada por el contrato",
        400,
        "DONATION_SIMULATION_FAILED",
      );
    }

    // ==================================================
    // ESTIMAR GAS
    // ==================================================

    let estimatedGas;

    try {
      estimatedGas = await ctx.writeContract.processDonation.estimateGas(
        normalizedDonor,
        parsedAmount,
        parsedValidAfter,
        parsedValidBefore,
        normalizedNonce,
        normalizedV,
        normalizedR,
        normalizedS,
      );

      console.log(`⛽ Gas estimado: ${estimatedGas}`);
    } catch (error) {
      console.error("❌ Error estimando gas:", getErrorMessage(error));

      throw new AppError(
        getRevertReason(error) || "No fue posible estimar el gas",
        400,
        "GAS_ESTIMATION_FAILED",
      );
    }

    // ==================================================
    // ENVIAR TRANSACCIÓN
    // ==================================================

    let tx;

    try {
      tx = await ctx.writeContract.processDonation(
        normalizedDonor,
        parsedAmount,
        parsedValidAfter,
        parsedValidBefore,
        normalizedNonce,
        normalizedV,
        normalizedR,
        normalizedS,
      );
    } catch (error) {
      console.error("❌ Error enviando TX:", getErrorMessage(error));

      throw new AppError(
        getRevertReason(error) || "No fue posible enviar la transacción",
        400,
        "TRANSACTION_SEND_FAILED",
      );
    }

    console.log(`⏳ TX enviada: ${tx.hash}`);

    // ==================================================
    // ESPERAR RECEIPT
    // ==================================================

    const receipt = await tx.wait();

    if (!receipt) {
      throw new AppError(
        "No se recibió el receipt de la transacción",
        502,
        "MISSING_RECEIPT",
      );
    }

    if (receipt.status !== 1) {
      throw new AppError(
        "La transacción fue minada pero falló",
        400,
        "TRANSACTION_REVERTED",
      );
    }

    console.log(`⛏️ TX minada en bloque ${receipt.blockNumber}`);

    // ==================================================
    // BUSCAR EVENTOS
    // ==================================================

    let donationReceived = null;
    let donationFailed = null;

    for (const log of receipt.logs) {
      /*
       * processDonation puede generar también logs
       * provenientes de USDC.
       *
       * Solo analizamos logs emitidos por DonationWallet.
       */

      if (log.address.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
        continue;
      }

      try {
        const parsed = ctx.readContract.interface.parseLog(log);

        if (!parsed) {
          continue;
        }

        // ----------------------------------------------
        // DonationReceived
        // ----------------------------------------------

        if (parsed.name === "DonationReceived") {
          donationReceived = {
            donor: parsed.args.donor,

            amount: parsed.args.amount.toString(),

            donorBalanceAfter: parsed.args.donorBalanceAfter.toString(),

            timestamp: parsed.args.timestamp.toString(),
          };
        }

        // ----------------------------------------------
        // DonationFailed
        // ----------------------------------------------

        if (parsed.name === "DonationFailed") {
          donationFailed = {
            donor: parsed.args.donor,

            nonce: parsed.args.nonce,

            reason: parsed.args.reason,
          };
        }
      } catch {
        // Ignorar logs desconocidos
      }
    }

    // ==================================================
    // DONATION FAILED
    // ==================================================

    if (donationFailed) {
      console.warn("⚠️ DonationFailed:", donationFailed.reason);

      return res.status(400).json({
        success: false,

        status: "failed",

        error: {
          code: "DONATION_FAILED_EVENT",

          message: donationFailed.reason,
        },

        tx: {
          hash: tx.hash,

          blockNumber: receipt.blockNumber,

          explorerUrl: getExplorerUrl(ctx.chainId, tx.hash),
        },

        event: donationFailed,
      });
    }

    // ==================================================
    // EVENTO NO ENCONTRADO
    // ==================================================

    if (!donationReceived) {
      console.warn("⚠️ TX exitosa pero DonationReceived no encontrado");

      return res.status(202).json({
        success: false,

        status: "mined_without_expected_event",

        message:
          "La transacción fue minada correctamente pero no emitió DonationReceived",

        tx: {
          hash: tx.hash,

          blockNumber: receipt.blockNumber,

          explorerUrl: getExplorerUrl(ctx.chainId, tx.hash),
        },
      });
    }

    // ==================================================
    // ÉXITO
    // ==================================================

    console.log(`✅ DONACIÓN CONFIRMADA: ${tx.hash}`);

    console.log("======================================");

    return res.status(200).json({
      success: true,

      status: "confirmed",

      donation: {
        donor: donationReceived.donor,

        amount: {
          raw: donationReceived.amount,

          formatted: ethers.formatUnits(
            donationReceived.amount,
            ctx.usdcDecimals,
          ),
        },

        donorBalanceAfter: {
          raw: donationReceived.donorBalanceAfter,

          formatted: ethers.formatUnits(
            donationReceived.donorBalanceAfter,
            ctx.usdcDecimals,
          ),
        },

        timestamp: donationReceived.timestamp,
      },

      gas: {
        estimated: estimatedGas.toString(),

        used: receipt.gasUsed?.toString() ?? null,
      },

      tx: {
        hash: tx.hash,

        blockNumber: receipt.blockNumber,

        explorerUrl: getExplorerUrl(ctx.chainId, tx.hash),
      },
    });
  }),
);


// ======================================================
// ADMIN - INFORMACIÓN DE RETIRO
// ======================================================

app.get(
  "/api/admin/withdraw-info",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ctx = await getBlockchain();

    assertBackendIsOwner(ctx);

    const [contractBalance, ownerTokenBalance, nativeBalance] =
      await Promise.all([
        ctx.readContract.getContractBalance(),
        ctx.usdcContract.balanceOf(ctx.owner),
        ctx.provider.getBalance(ctx.signerAddress),
      ]);

    return res.status(200).json({
      success: true,

      network: {
        chainId: ctx.chainId.toString(),
      },

      contract: {
        address: CONTRACT_ADDRESS,
        owner: ctx.owner,
        backendSigner: ctx.signerAddress,
        signerIsOwner: true,
      },

      token: {
        address: ctx.usdcAddress,
        name: ctx.tokenName,
        symbol: ctx.tokenSymbol,
        decimals: ctx.usdcDecimals,
      },

      balances: {
        contract: {
          raw: contractBalance.toString(),
          formatted: ethers.formatUnits(
            contractBalance,
            ctx.usdcDecimals,
          ),
        },

        owner: {
          raw: ownerTokenBalance.toString(),
          formatted: ethers.formatUnits(
            ownerTokenBalance,
            ctx.usdcDecimals,
          ),
        },

        signerNative: ethers.formatEther(nativeBalance),
      },
    });
  }),
);

// ======================================================
// ADMIN - RETIRAR TODO AL OWNER
// ======================================================

app.post(
  "/api/withdraw-all",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { confirm } = req.body || {};

    if (confirm !== "WITHDRAW_ALL") {
      throw new AppError(
        'Para confirmar envía {"confirm":"WITHDRAW_ALL"}',
        400,
        "CONFIRMATION_REQUIRED",
      );
    }

    const ctx = await getBlockchain();

    assertBackendIsOwner(ctx);

    const balanceBefore = await ctx.readContract.getContractBalance();

    if (balanceBefore <= 0n) {
      throw new AppError(
        `El contrato no tiene ${ctx.tokenSymbol} para retirar`,
        400,
        "NOTHING_TO_WITHDRAW",
      );
    }

    // Simulación: detecta onlyOwner, token inválido, saldo, etc.
    try {
      await ctx.writeContract.withdrawAll.staticCall();
    } catch (error) {
      throw new AppError(
        getRevertReason(error) ||
          getErrorMessage(error) ||
          "withdrawAll() sería rechazado por el contrato",
        400,
        "WITHDRAW_SIMULATION_FAILED",
      );
    }

    let estimatedGas;

    try {
      estimatedGas = await ctx.writeContract.withdrawAll.estimateGas();
    } catch (error) {
      throw new AppError(
        getRevertReason(error) ||
          getErrorMessage(error) ||
          "No fue posible estimar el gas",
        400,
        "WITHDRAW_GAS_ESTIMATION_FAILED",
      );
    }

    const tx = await ctx.writeContract.withdrawAll({
      gasLimit: addGasMargin(estimatedGas),
    });

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new AppError(
        "La transacción de retiro fue minada pero falló",
        400,
        "WITHDRAW_REVERTED",
      );
    }

    const [balanceAfter, ownerBalanceAfter] = await Promise.all([
      ctx.readContract.getContractBalance(),
      ctx.usdcContract.balanceOf(ctx.owner),
    ]);

    return res.status(200).json({
      success: true,
      status: "confirmed",

      withdrawal: {
        mode: "all",
        to: ctx.owner,

        amount: {
          raw: balanceBefore.toString(),
          formatted: ethers.formatUnits(
            balanceBefore,
            ctx.usdcDecimals,
          ),
          symbol: ctx.tokenSymbol,
        },

        contractBalanceAfter: {
          raw: balanceAfter.toString(),
          formatted: ethers.formatUnits(
            balanceAfter,
            ctx.usdcDecimals,
          ),
        },

        ownerBalanceAfter: {
          raw: ownerBalanceAfter.toString(),
          formatted: ethers.formatUnits(
            ownerBalanceAfter,
            ctx.usdcDecimals,
          ),
        },
      },

      gas: {
        estimated: estimatedGas.toString(),
        used: receipt.gasUsed?.toString() ?? null,
      },

      tx: {
        hash: tx.hash,
        blockNumber: receipt.blockNumber,
        explorerUrl: getExplorerUrl(ctx.chainId, tx.hash),
      },
    });
  }),
);

// ======================================================
// ADMIN - RETIRO PARCIAL
// ======================================================

app.post(
  "/api/withdraw",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { to, amount, confirm } = req.body || {};

    if (confirm !== "WITHDRAW") {
      throw new AppError(
        'Para confirmar envía {"confirm":"WITHDRAW"}',
        400,
        "CONFIRMATION_REQUIRED",
      );
    }

    const ctx = await getBlockchain();

    assertBackendIsOwner(ctx);

    const normalizedTo = validateAddress(to, "to");
    const parsedAmount = parseTokenAmount(
      amount,
      ctx.usdcDecimals,
      "amount",
    );

    const balanceBefore = await ctx.readContract.getContractBalance();

    if (balanceBefore < parsedAmount) {
      throw new AppError(
        `Saldo insuficiente en el contrato. Disponible: ${ethers.formatUnits(
          balanceBefore,
          ctx.usdcDecimals,
        )} ${ctx.tokenSymbol}`,
        400,
        "INSUFFICIENT_CONTRACT_BALANCE",
      );
    }

    try {
      await ctx.writeContract.withdrawDonations.staticCall(
        normalizedTo,
        parsedAmount,
      );
    } catch (error) {
      throw new AppError(
        getRevertReason(error) ||
          getErrorMessage(error) ||
          "withdrawDonations() sería rechazado por el contrato",
        400,
        "WITHDRAW_SIMULATION_FAILED",
      );
    }

    let estimatedGas;

    try {
      estimatedGas =
        await ctx.writeContract.withdrawDonations.estimateGas(
          normalizedTo,
          parsedAmount,
        );
    } catch (error) {
      throw new AppError(
        getRevertReason(error) ||
          getErrorMessage(error) ||
          "No fue posible estimar el gas",
        400,
        "WITHDRAW_GAS_ESTIMATION_FAILED",
      );
    }

    const tx = await ctx.writeContract.withdrawDonations(
      normalizedTo,
      parsedAmount,
      {
        gasLimit: addGasMargin(estimatedGas),
      },
    );

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new AppError(
        "La transacción de retiro fue minada pero falló",
        400,
        "WITHDRAW_REVERTED",
      );
    }

    const balanceAfter = await ctx.readContract.getContractBalance();

    return res.status(200).json({
      success: true,
      status: "confirmed",

      withdrawal: {
        mode: "partial",
        to: normalizedTo,

        amount: {
          raw: parsedAmount.toString(),
          formatted: ethers.formatUnits(
            parsedAmount,
            ctx.usdcDecimals,
          ),
          symbol: ctx.tokenSymbol,
        },

        contractBalanceBefore: {
          raw: balanceBefore.toString(),
          formatted: ethers.formatUnits(
            balanceBefore,
            ctx.usdcDecimals,
          ),
        },

        contractBalanceAfter: {
          raw: balanceAfter.toString(),
          formatted: ethers.formatUnits(
            balanceAfter,
            ctx.usdcDecimals,
          ),
        },
      },

      gas: {
        estimated: estimatedGas.toString(),
        used: receipt.gasUsed?.toString() ?? null,
      },

      tx: {
        hash: tx.hash,
        blockNumber: receipt.blockNumber,
        explorerUrl: getExplorerUrl(ctx.chainId, tx.hash),
      },
    });
  }),
);

// ======================================================
// 404
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,

    error: {
      code: "ROUTE_NOT_FOUND",

      message: "Ruta no encontrada",
    },
  });
});

// ======================================================
// ERROR HANDLER GLOBAL
// ======================================================

app.use((error, req, res, next) => {
  console.error("======================================");

  console.error("❌ ERROR API");

  console.error({
    method: req.method,

    path: req.originalUrl,

    code: error?.code,

    message: getErrorMessage(error),
  });

  console.error("======================================");

  // ==================================================
  // APP ERROR
  // ==================================================

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,

      error: {
        code: error.code,

        message: error.message,

        ...(!IS_PRODUCTION &&
          error.details && {
            details: error.details,
          }),
      },
    });
  }

  // ==================================================
  // JSON INVÁLIDO
  // ==================================================

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      success: false,

      error: {
        code: "INVALID_JSON",

        message: "El JSON enviado es inválido",
      },
    });
  }

  // ==================================================
  // ETHERS CALL EXCEPTION
  // ==================================================

  if (error.code === "CALL_EXCEPTION" || error.code === "ACTION_REJECTED") {
    return res.status(400).json({
      success: false,

      error: {
        code: error.code,

        message:
          getRevertReason(error) ||
          "La operación fue rechazada por el contrato",
      },
    });
  }

  // ==================================================
  // RPC
  // ==================================================

  if (
    error.code === "NETWORK_ERROR" ||
    error.code === "SERVER_ERROR" ||
    error.code === "TIMEOUT"
  ) {
    return res.status(502).json({
      success: false,

      error: {
        code: "RPC_ERROR",

        message: "No fue posible comunicarse con la blockchain",
      },
    });
  }

  // ==================================================
  // ERROR INTERNO
  // ==================================================

  return res.status(500).json({
    success: false,

    error: {
      code: "INTERNAL_SERVER_ERROR",

      message: IS_PRODUCTION
        ? "Error interno del servidor"
        : getErrorMessage(error),
    },
  });
});
// ======================================================
// EXPORT VERCEL
// ======================================================

export default app;
