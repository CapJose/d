// api/server.js

import "dotenv/config";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";

// ======================================================
// CONFIGURACIÓN
// ======================================================

const app = express();

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

const RPC_URL = process.env.MAINNET_RPC_URL?.trim();
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS?.trim();

const EXPECTED_CHAIN_ID = process.env.EXPECTED_CHAIN_ID
  ? BigInt(process.env.EXPECTED_CHAIN_ID)
  : null;

const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL?.replace(/\/$/, "");

// Ejemplo:
// ALLOWED_ORIGINS=http://localhost:5173,https://miweb.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// ======================================================
// MIDDLEWARE
// ======================================================

app.disable("x-powered-by");

app.use(
  cors({
    origin(origin, callback) {
      // Permitir herramientas server-to-server, Postman, curl, etc.
      if (!origin) {
        return callback(null, true);
      }

      // En desarrollo, si no hay lista configurada, permitir.
      if (!IS_PRODUCTION && ALLOWED_ORIGINS.length === 0) {
        return callback(null, true);
      }

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      const error = new Error("Origen no permitido por CORS");
      error.statusCode = 403;

      return callback(error);
    },

    methods: ["GET", "POST", "OPTIONS"],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],

    maxAge: 86400,
  })
);

// Limitar tamaño del body.
// Evita requests gigantes innecesarios.
app.use(
  express.json({
    limit: "50kb",
    strict: true,
  })
);

// ======================================================
// ABI
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
];

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
// ERRORES PERSONALIZADOS
// ======================================================

class AppError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", details = null) {
    super(message);

    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ======================================================
// HELPERS
// ======================================================

function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

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
      "MISSING_ENV"
    );
  }

  if (!ethers.isAddress(CONTRACT_ADDRESS)) {
    throw new AppError(
      "CONTRACT_ADDRESS no es una dirección Ethereum válida",
      503,
      "INVALID_CONTRACT_ADDRESS"
    );
  }

  // Esto valida indirectamente la private key.
  try {
    new ethers.Wallet(PRIVATE_KEY);
  } catch {
    throw new AppError(
      "PRIVATE_KEY tiene un formato inválido",
      503,
      "INVALID_PRIVATE_KEY"
    );
  }
}

function validateAddress(address, fieldName = "address") {
  if (
    typeof address !== "string" ||
    !ethers.isAddress(address)
  ) {
    throw new AppError(
      `${fieldName} no es una dirección Ethereum válida`,
      400,
      "INVALID_ADDRESS"
    );
  }

  return ethers.getAddress(address);
}

function validateBytes32(value, fieldName) {
  if (
    typeof value !== "string" ||
    !/^0x[a-fA-F0-9]{64}$/.test(value)
  ) {
    throw new AppError(
      `${fieldName} debe ser bytes32 (0x + 64 caracteres hexadecimales)`,
      400,
      "INVALID_BYTES32"
    );
  }

  return value;
}

function parseUnsignedInteger(value, fieldName) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    throw new AppError(
      `Falta el campo ${fieldName}`,
      400,
      "MISSING_FIELD"
    );
  }

  /*
   * IMPORTANTE:
   *
   * Preferimos strings para números blockchain.
   *
   * Correcto:
   * {
   *   "amount": "1000000"
   * }
   *
   * Evitar:
   * {
   *   "amount": 1000000000000000000
   * }
   *
   * porque JavaScript puede perder precisión.
   */
  if (
    typeof value === "number" &&
    !Number.isSafeInteger(value)
  ) {
    throw new AppError(
      `${fieldName} debe enviarse como string para evitar pérdida de precisión`,
      400,
      "UNSAFE_INTEGER"
    );
  }

  let parsed;

  try {
    parsed = BigInt(value);
  } catch {
    throw new AppError(
      `${fieldName} debe ser un entero válido`,
      400,
      "INVALID_INTEGER"
    );
  }

  if (parsed < 0n) {
    throw new AppError(
      `${fieldName} no puede ser negativo`,
      400,
      "INVALID_INTEGER"
    );
  }

  return parsed;
}

function validateSignatureV(value) {
  const parsed = parseUnsignedInteger(value, "v");

  /*
   * Firmas Ethereum tradicionales utilizan normalmente
   * 27/28, aunque algunas implementaciones entregan 0/1.
   *
   * Las normalizamos a 27/28.
   */
  if (parsed === 0n) {
    return 27;
  }

  if (parsed === 1n) {
    return 28;
  }

  if (parsed === 27n || parsed === 28n) {
    return Number(parsed);
  }

  throw new AppError(
    "v debe ser 0, 1, 27 o 28",
    400,
    "INVALID_SIGNATURE_V"
  );
}

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

function getRevertReason(error) {
  return (
    error?.reason ||
    error?.revert?.args?.[0] ||
    error?.info?.error?.message ||
    error?.shortMessage ||
    null
  );
}

function getExplorerUrl(chainId, txHash) {
  if (EXPLORER_BASE_URL) {
    return `${EXPLORER_BASE_URL}/tx/${txHash}`;
  }

  const explorers = {
    "1": "https://etherscan.io",
    "11155111": "https://sepolia.etherscan.io",

    "137": "https://polygonscan.com",
    "80002": "https://amoy.polygonscan.com",

    "8453": "https://basescan.org",
    "84532": "https://sepolia.basescan.org",

    "42161": "https://arbiscan.io",

    "10": "https://optimistic.etherscan.io",

    "56": "https://bscscan.com",
  };

  const explorer = explorers[chainId.toString()];

  if (!explorer) {
    return null;
  }

  return `${explorer}/tx/${txHash}`;
}

// ======================================================
// INICIALIZACIÓN BLOCKCHAIN
// ======================================================

async function initializeBlockchain() {
  validateEnvironment();

  console.log("🔌 Inicializando conexión blockchain...");

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Comprueba conexión RPC.
  const network = await provider.getNetwork();

  if (
    EXPECTED_CHAIN_ID !== null &&
    network.chainId !== EXPECTED_CHAIN_ID
  ) {
    throw new AppError(
      `RPC conectado a chainId ${network.chainId}, pero se esperaba ${EXPECTED_CHAIN_ID}`,
      503,
      "WRONG_NETWORK"
    );
  }

  // Verificar que realmente exista código en CONTRACT_ADDRESS.
  const contractCode = await provider.getCode(CONTRACT_ADDRESS);

  if (!contractCode || contractCode === "0x") {
    throw new AppError(
      `No existe ningún contrato desplegado en ${CONTRACT_ADDRESS} para chainId ${network.chainId}`,
      503,
      "CONTRACT_NOT_DEPLOYED"
    );
  }

  const ownerWallet = new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

  /*
   * Contrato de lectura.
   *
   * Para funciones view no necesitamos firmante.
   */
  const readContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    DONATION_WALLET_ABI,
    provider
  );

  /*
   * Contrato de escritura.
   *
   * processDonation necesita poder enviar una TX.
   */
  const writeContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    DONATION_WALLET_ABI,
    ownerWallet
  );

  // Validar que este contrato responde a nuestra ABI.
  const [usdcAddressRaw, ownerRaw] = await Promise.all([
    readContract.usdcToken(),
    readContract.owner(),
  ]);

  const usdcAddress = validateAddress(
    usdcAddressRaw,
    "usdcToken"
  );

  const owner = validateAddress(
    ownerRaw,
    "owner"
  );

  // Comprobar que USDC también sea un contrato.
  const usdcCode = await provider.getCode(usdcAddress);

  if (!usdcCode || usdcCode === "0x") {
    throw new AppError(
      `usdcToken() apunta a una dirección sin contrato: ${usdcAddress}`,
      503,
      "INVALID_USDC_CONTRACT"
    );
  }

  const usdcContract = new ethers.Contract(
    usdcAddress,
    ERC20_ABI,
    provider
  );

  const [decimals, name, symbol] = await Promise.all([
    usdcContract.decimals(),
    usdcContract.name().catch(() => "USDC"),
    usdcContract.symbol().catch(() => "USDC"),
  ]);

  if (Number(decimals) < 0 || Number(decimals) > 255) {
    throw new AppError(
      "El token devuelve decimals inválidos",
      503,
      "INVALID_TOKEN"
    );
  }

  const signerAddress = ownerWallet.address;

  console.log("✅ Blockchain inicializada");
  console.log(`🌐 Chain ID: ${network.chainId}`);
  console.log(`📜 Contrato: ${CONTRACT_ADDRESS}`);
  console.log(`💵 Token: ${symbol} (${usdcAddress})`);
  console.log(`👑 Owner contrato: ${owner}`);
  console.log(`🔐 Backend signer: ${signerAddress}`);

  if (
    owner.toLowerCase() !== signerAddress.toLowerCase()
  ) {
    console.warn(
      "⚠️ PRIVATE_KEY no corresponde al owner() del contrato"
    );
  }

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
    usdcDecimals: Number(decimals),

    tokenName: name,
    tokenSymbol: symbol,
  };
}

async function getBlockchain() {
  if (blockchain) {
    return blockchain;
  }

  /*
   * Evita inicializaciones concurrentes si llegan
   * varios requests simultáneamente.
   */
  if (!initializationPromise) {
    initializationPromise = initializeBlockchain()
      .then((result) => {
        blockchain = result;
        return result;
      })
      .catch((error) => {
        /*
         * IMPORTANTE:
         *
         * No dejamos una Promise rechazada cacheada.
         * Así si Alchemy/Infura/RPC falla temporalmente,
         * una petición futura puede volver a intentar.
         */
        initializationPromise = null;

        throw error;
      });
  }

  return initializationPromise;
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Donation Wallet API",
    status: "running",
  });
});

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

        ...(!IS_PRODUCTION && {
          error: getErrorMessage(error),
        }),
      });
    }
  })
);

// ======================================================
// /api/info
// ======================================================

app.get(
  "/api/info",
  asyncHandler(async (req, res) => {
    const ctx = await getBlockchain();

    const [
      contractBalance,
      nativeBalance,
      blockNumber,
    ] = await Promise.all([
      ctx.readContract.getContractBalance(),

      ctx.provider.getBalance(
        ctx.signerAddress
      ),

      ctx.provider.getBlockNumber(),
    ]);

    return res.json({
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
          ctx.signerAddress.toLowerCase() ===
          ctx.owner.toLowerCase(),
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
          ctx.usdcDecimals
        ),

        signerNative: ethers.formatEther(
          nativeBalance
        ),
      },
    });
  })
);

// ======================================================
// /api/balance/:address
// ======================================================

app.get(
  "/api/balance/:address",
  asyncHandler(async (req, res) => {
    const address = validateAddress(
      req.params.address
    );

    const ctx = await getBlockchain();

    const [
      balance,
      donorBalance,
    ] = await Promise.all([
      ctx.usdcContract.balanceOf(address),

      ctx.readContract.getDonorBalance(address),
    ]);

    let donationAmount = null;
    let donationError = null;

    try {
      donationAmount =
        await ctx.readContract.calculateRequiredDonation(
          address
        );
    } catch (error) {
      /*
       * Ya NO asumimos que cualquier revert significa
       * "saldo insuficiente".
       *
       * Guardamos la razón real si existe.
       */
      donationError = {
        code: error.code || "CALCULATION_REVERTED",

        message:
          getRevertReason(error) ||
          "No fue posible calcular la donación requerida",
      };
    }

    return res.json({
      success: true,

      address,

      token: {
        symbol: ctx.tokenSymbol,
        decimals: ctx.usdcDecimals,
      },

      walletBalance: {
        raw: balance.toString(),

        formatted: ethers.formatUnits(
          balance,
          ctx.usdcDecimals
        ),
      },

      donorBalance: {
        raw: donorBalance.toString(),

        formatted: ethers.formatUnits(
          donorBalance,
          ctx.usdcDecimals
        ),
      },

      requiredDonation:
        donationAmount !== null
          ? {
              raw: donationAmount.toString(),

              formatted: ethers.formatUnits(
                donationAmount,
                ctx.usdcDecimals
              ),
            }
          : null,

      donationError,
    });
  })
);

// ======================================================
// /api/donor/:address
// ======================================================

app.get(
  "/api/donor/:address",
  asyncHandler(async (req, res) => {
    const address = validateAddress(
      req.params.address
    );

    const ctx = await getBlockchain();

    const [total, count] =
      await ctx.readContract.getDonorStats(address);

    return res.json({
      success: true,

      address,

      totalDonated: {
        raw: total.toString(),

        formatted: ethers.formatUnits(
          total,
          ctx.usdcDecimals
        ),
      },

      donationCount: count.toString(),
    });
  })
);

// ======================================================
// /api/donate
// ======================================================

app.post(
  "/api/donate",
  asyncHandler(async (req, res) => {
    const {
      donor,
      amount,
      validAfter,
      validBefore,
      nonce,
      v,
      r,
      s,
    } = req.body || {};

    // --------------------------------------------------
    // Validar parámetros
    // --------------------------------------------------

    const normalizedDonor = validateAddress(
      donor,
      "donor"
    );

    const parsedAmount = parseUnsignedInteger(
      amount,
      "amount"
    );

    const parsedValidAfter = parseUnsignedInteger(
      validAfter,
      "validAfter"
    );

    const parsedValidBefore = parseUnsignedInteger(
      validBefore,
      "validBefore"
    );

    if (parsedAmount === 0n) {
      throw new AppError(
        "amount debe ser mayor que cero",
        400,
        "INVALID_AMOUNT"
      );
    }

    if (
      parsedValidBefore <= parsedValidAfter
    ) {
      throw new AppError(
        "validBefore debe ser mayor que validAfter",
        400,
        "INVALID_VALIDITY_WINDOW"
      );
    }

    const normalizedNonce = validateBytes32(
      nonce,
      "nonce"
    );

    const normalizedR = validateBytes32(r, "r");
    const normalizedS = validateBytes32(s, "s");

    const normalizedV = validateSignatureV(v);

    const ctx = await getBlockchain();

    console.log(
      `📥 Solicitud de donación: donor=${normalizedDonor}, amount=${parsedAmount}`
    );

    // --------------------------------------------------
    // SIMULAR LA TRANSACCIÓN
    // --------------------------------------------------

    /*
     * Este paso es MUY importante.
     *
     * Ejecutamos eth_call usando exactamente la misma
     * función antes de mandar una transacción real.
     *
     * Si la autorización ya fue usada, está expirada,
     * amount es incorrecto, no existe balance,
     * processDonation hace revert, etc., detenemos aquí.
     *
     * No gastamos gas innecesariamente.
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
        normalizedS
      );
    } catch (error) {
      console.error(
        "❌ Simulación de donación fallida:",
        getErrorMessage(error)
      );

      throw new AppError(
        getRevertReason(error) ||
          "La transacción sería rechazada por el contrato",
        400,
        "DONATION_SIMULATION_FAILED"
      );
    }

    // --------------------------------------------------
    // ESTIMAR GAS
    // --------------------------------------------------

    let estimatedGas = null;

    try {
      estimatedGas =
        await ctx.writeContract.processDonation.estimateGas(
          normalizedDonor,
          parsedAmount,
          parsedValidAfter,
          parsedValidBefore,
          normalizedNonce,
          normalizedV,
          normalizedR,
          normalizedS
        );
    } catch (error) {
      console.error(
        "❌ Error estimando gas:",
        getErrorMessage(error)
      );

      throw new AppError(
        "No fue posible estimar el gas de la donación",
        400,
        "GAS_ESTIMATION_FAILED"
      );
    }

    // --------------------------------------------------
    // ENVIAR TX
    // --------------------------------------------------

    const tx =
      await ctx.writeContract.processDonation(
        normalizedDonor,
        parsedAmount,
        parsedValidAfter,
        parsedValidBefore,
        normalizedNonce,
        normalizedV,
        normalizedR,
        normalizedS
      );

    console.log(`⏳ TX enviada: ${tx.hash}`);

    // --------------------------------------------------
    // ESPERAR CONFIRMACIÓN
    // --------------------------------------------------

    const receipt = await tx.wait();

    if (!receipt) {
      throw new AppError(
        "No se recibió el receipt de la transacción",
        502,
        "MISSING_RECEIPT"
      );
    }

    if (receipt.status !== 1) {
      throw new AppError(
        "La transacción fue minada pero falló",
        400,
        "TRANSACTION_REVERTED"
      );
    }

    // --------------------------------------------------
    // ANALIZAR EVENTOS
    // --------------------------------------------------

    let donationReceived = null;
    let donationFailed = null;

    for (const log of receipt.logs) {
      /*
       * Ignorar logs de USDC u otros contratos.
       */
      if (
        log.address.toLowerCase() !==
        CONTRACT_ADDRESS.toLowerCase()
      ) {
        continue;
      }

      try {
        const parsed =
          ctx.readContract.interface.parseLog(log);

        if (!parsed) {
          continue;
        }

        if (parsed.name === "DonationReceived") {
          donationReceived = {
            donor: parsed.args.donor,

            amount: parsed.args.amount.toString(),

            donorBalanceAfter:
              parsed.args.donorBalanceAfter.toString(),

            timestamp:
              parsed.args.timestamp.toString(),
          };
        }

        if (parsed.name === "DonationFailed") {
          donationFailed = {
            donor: parsed.args.donor,
            nonce: parsed.args.nonce,
            reason: parsed.args.reason,
          };
        }
      } catch {
        // Log que no pertenece a nuestra ABI.
      }
    }

    // --------------------------------------------------
    // RESULTADO
    // --------------------------------------------------

    if (donationFailed) {
      console.warn(
        `⚠️ DonationFailed emitido: ${donationFailed.reason}`
      );

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

          explorerUrl: getExplorerUrl(
            ctx.chainId,
            tx.hash
          ),
        },

        event: donationFailed,
      });
    }

    if (!donationReceived) {
      console.warn(
        "⚠️ La TX fue exitosa pero no se encontró DonationReceived"
      );

      return res.status(202).json({
        success: false,

        status: "mined_without_expected_event",

        message:
          "La transacción fue minada correctamente, pero no emitió DonationReceived",

        tx: {
          hash: tx.hash,

          blockNumber:
            receipt.blockNumber,

          explorerUrl: getExplorerUrl(
            ctx.chainId,
            tx.hash
          ),
        },
      });
    }

    console.log(
      `✅ Donación confirmada: ${tx.hash}`
    );

    return res.status(200).json({
      success: true,

      status: "confirmed",

      donation: {
        donor: donationReceived.donor,

        amount: {
          raw: donationReceived.amount,

          formatted: ethers.formatUnits(
            donationReceived.amount,
            ctx.usdcDecimals
          ),
        },

        donorBalanceAfter: {
          raw:
            donationReceived.donorBalanceAfter,

          formatted: ethers.formatUnits(
            donationReceived.donorBalanceAfter,
            ctx.usdcDecimals
          ),
        },

        timestamp:
          donationReceived.timestamp,
      },

      gas: {
        estimated:
          estimatedGas?.toString() ?? null,

        used:
          receipt.gasUsed?.toString() ?? null,
      },

      tx: {
        hash: tx.hash,

        blockNumber:
          receipt.blockNumber,

        explorerUrl: getExplorerUrl(
          ctx.chainId,
          tx.hash
        ),
      },
    });
  })
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
  console.error("❌ Error:", {
    method: req.method,
    path: req.originalUrl,
    code: error?.code,
    message: getErrorMessage(error),
  });

  // Error propio de nuestra API.
  if (error instanceof AppError) {
    return res
      .status(error.statusCode)
      .json({
        success: false,

        error: {
          code: error.code,
          message: error.message,

          ...(
            !IS_PRODUCTION &&
            error.details && {
              details: error.details,
            }
          ),
        },
      });
  }

  // JSON inválido.
  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error
  ) {
    return res.status(400).json({
      success: false,

      error: {
        code: "INVALID_JSON",
        message: "El JSON enviado es inválido",
      },
    });
  }

  // CORS.
  if (error.statusCode === 403) {
    return res.status(403).json({
      success: false,

      error: {
        code: "CORS_FORBIDDEN",
        message: "Origen no permitido",
      },
    });
  }

  /*
   * Reverts del contrato.
   */
  if (
    error.code === "CALL_EXCEPTION" ||
    error.code === "ACTION_REJECTED"
  ) {
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

  /*
   * Errores del RPC.
   */
  if (
    error.code === "NETWORK_ERROR" ||
    error.code === "SERVER_ERROR" ||
    error.code === "TIMEOUT"
  ) {
    return res.status(502).json({
      success: false,

      error: {
        code: "RPC_ERROR",
        message:
          "No fue posible comunicarse correctamente con la blockchain",
      },
    });
  }

  // Error desconocido.
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
