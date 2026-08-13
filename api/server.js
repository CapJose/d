// api/server.js

import "dotenv/config";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";

const app = express();

/* =========================================================
   CONFIGURACIÓN
========================================================= */

const CONFIG = {
  RPC_URL: process.env.MAINNET_RPC_URL,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS,

  // Opcional pero MUY recomendado para proteger /api/donate
  API_SECRET: process.env.API_SECRET,

  EXPECTED_CHAIN_ID: 1n,

  // USDC oficial Ethereum Mainnet
  EXPECTED_USDC:
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",

  CONFIRMATIONS: Number(
    process.env.TX_CONFIRMATIONS || 1
  ),

  MAX_BODY_SIZE: "20kb",

  // CORS
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [],
};

/* =========================================================
   ABI
========================================================= */

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
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

/* =========================================================
   EXPRESS
========================================================= */

// Importante si estás detrás de Vercel / reverse proxy
app.set("trust proxy", 1);

app.disable("x-powered-by");

app.use(
  express.json({
    limit: CONFIG.MAX_BODY_SIZE,
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // curl/Postman/server-to-server no siempre envían Origin
      if (!origin) {
        return callback(null, true);
      }

      // Si no configuraste lista, permitimos temporalmente.
      // Para producción conviene definir ALLOWED_ORIGINS.
      if (CONFIG.ALLOWED_ORIGINS.length === 0) {
        return callback(null, true);
      }

      if (CONFIG.ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Origen no permitido por CORS")
      );
    },

    methods: ["GET", "POST"],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
    ],
  })
);

/* =========================================================
   ESTADO BLOCKCHAIN
========================================================= */

let provider = null;

let rawWallet = null;

let signer = null;

let contract = null;

let readContract = null;

let usdcContract = null;

let blockchainReady = false;

let blockchainInitializationError = null;

let initializationPromise = null;

/* =========================================================
   HELPERS
========================================================= */

function requiredEnv(name, value) {
  if (!value) {
    throw new Error(
      `Variable de entorno requerida no definida: ${name}`
    );
  }

  return value;
}

function normalizePrivateKey(privateKey) {
  if (!privateKey) {
    return null;
  }

  const key = privateKey.trim();

  if (key.startsWith("0x")) {
    return key;
  }

  return `0x${key}`;
}

function isBytes32(value) {
  return (
    typeof value === "string" &&
    /^0x[a-fA-F0-9]{64}$/.test(value)
  );
}

function parseUint(value, fieldName) {
  try {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      throw new Error();
    }

    const parsed = BigInt(value);

    if (parsed < 0n) {
      throw new Error();
    }

    return parsed;
  } catch {
    throw new Error(
      `${fieldName} debe ser un uint256 válido`
    );
  }
}

function sanitizeError(err) {
  const code = err?.code || "UNKNOWN_ERROR";

  let message =
    err?.shortMessage ||
    err?.reason ||
    err?.message ||
    "Error desconocido";

  // Evitamos accidentalmente devolver RPC URL / claves
  if (CONFIG.RPC_URL) {
    message = message.replaceAll(
      CONFIG.RPC_URL,
      "[RPC_URL]"
    );
  }

  if (CONFIG.PRIVATE_KEY) {
    message = message.replaceAll(
      CONFIG.PRIVATE_KEY,
      "[PRIVATE_KEY]"
    );
  }

  return {
    code,
    message,
  };
}

function asyncHandler(fn) {
  return function handler(req, res, next) {
    Promise.resolve(
      fn(req, res, next)
    ).catch(next);
  };
}

/* =========================================================
   INICIALIZACIÓN BLOCKCHAIN
========================================================= */

async function initializeBlockchain() {
  try {
    console.log(
      "🔄 Inicializando conexión blockchain..."
    );

    const rpcUrl = requiredEnv(
      "MAINNET_RPC_URL",
      CONFIG.RPC_URL
    );

    const privateKey = normalizePrivateKey(
      requiredEnv(
        "PRIVATE_KEY",
        CONFIG.PRIVATE_KEY
      )
    );

    const contractAddress = requiredEnv(
      "CONTRACT_ADDRESS",
      CONFIG.CONTRACT_ADDRESS
    );

    if (!ethers.isAddress(contractAddress)) {
      throw new Error(
        "CONTRACT_ADDRESS no es una dirección Ethereum válida"
      );
    }

    /*
     * Como sabemos que esperamos mainnet,
     * indicamos network explícitamente.
     *
     * staticNetwork evita verificaciones repetidas
     * de chainId una vez establecido.
     */
    provider = new ethers.JsonRpcProvider(
      rpcUrl,
      {
        name: "mainnet",
        chainId: 1,
      },
      {
        staticNetwork: true,
      }
    );

    // Verificar RPC
    const network = await provider.getNetwork();

    console.log(
      "🌐 RPC chainId:",
      network.chainId.toString()
    );

    if (
      network.chainId !==
      CONFIG.EXPECTED_CHAIN_ID
    ) {
      throw new Error(
        `RPC incorrecto. Esperado chainId=1 pero recibido chainId=${network.chainId}`
      );
    }

    /*
     * Comprobamos que haya bytecode en CONTRACT_ADDRESS.
     */
    const code = await provider.getCode(
      contractAddress
    );

    if (!code || code === "0x") {
      throw new Error(
        `No existe contrato desplegado en ${contractAddress}`
      );
    }

    rawWallet = new ethers.Wallet(
      privateKey,
      provider
    );

    /*
     * Protege mejor las transacciones concurrentes
     * desde la misma private key.
     */
    signer = new ethers.NonceManager(
      rawWallet
    );

    /*
     * Contrato lectura: provider.
     * Contrato escritura: signer.
     */
    readContract = new ethers.Contract(
      contractAddress,
      DONATION_WALLET_ABI,
      provider
    );

    contract = new ethers.Contract(
      contractAddress,
      DONATION_WALLET_ABI,
      signer
    );

    /*
     * Verificaciones del contrato
     */
    const [contractOwner, usdcAddress] =
      await Promise.all([
        readContract.owner(),
        readContract.usdcToken(),
      ]);

    console.log(
      "📄 Contract:",
      contractAddress
    );

    console.log(
      "👑 Contract owner:",
      contractOwner
    );

    console.log(
      "🔐 Backend wallet:",
      rawWallet.address
    );

    console.log(
      "💵 USDC:",
      usdcAddress
    );

    /*
     * Si processDonation tiene onlyOwner
     * o algún control equivalente, esto es crítico.
     */
    if (
      contractOwner.toLowerCase() !==
      rawWallet.address.toLowerCase()
    ) {
      console.warn(
        "⚠️ La wallet del backend NO coincide con owner() del contrato."
      );
    }

    /*
     * Garantizamos que el contrato apunta
     * al USDC oficial de Ethereum Mainnet.
     */
    if (
      usdcAddress.toLowerCase() !==
      CONFIG.EXPECTED_USDC.toLowerCase()
    ) {
      throw new Error(
        `El contrato apunta a un token inesperado: ${usdcAddress}`
      );
    }

    usdcContract = new ethers.Contract(
      usdcAddress,
      ERC20_ABI,
      provider
    );

    /*
     * Verificamos decimals.
     */
    const decimals =
      await usdcContract.decimals();

    if (Number(decimals) !== 6) {
      throw new Error(
        `El token configurado no tiene 6 decimales. decimals=${decimals}`
      );
    }

    /*
     * Balance de ETH del backend.
     */
    const ethBalance =
      await provider.getBalance(
        rawWallet.address
      );

    console.log(
      "⛽ Backend ETH:",
      ethers.formatEther(
        ethBalance
      )
    );

    if (ethBalance === 0n) {
      console.warn(
        "⚠️ La wallet del backend no tiene ETH para pagar gas."
      );
    }

    blockchainReady = true;
    blockchainInitializationError = null;

    console.log(
      "✅ Blockchain inicializada correctamente"
    );
  } catch (error) {
    blockchainReady = false;

    blockchainInitializationError =
      sanitizeError(error);

    console.error(
      "❌ Error inicializando blockchain:",
      blockchainInitializationError
    );

    throw error;
  }
}

function ensureInitialized() {
  if (blockchainReady) {
    return Promise.resolve();
  }

  if (!initializationPromise) {
    initializationPromise =
      initializeBlockchain().catch(
        (error) => {
          /*
           * Permite intentar inicializar nuevamente
           * en la siguiente petición.
           */
          initializationPromise = null;

          throw error;
        }
      );
  }

  return initializationPromise;
}

/* =========================================================
   MIDDLEWARE BLOCKCHAIN
========================================================= */

async function blockchainMiddleware(
  req,
  res,
  next
) {
  try {
    await ensureInitialized();

    next();
  } catch {
    return res.status(503).json({
      success: false,

      error:
        "Servicio blockchain no disponible",

      details:
        blockchainInitializationError,
    });
  }
}

/* =========================================================
   AUTENTICACIÓN DEL ENDPOINT DE ESCRITURA
========================================================= */

function requireApiSecret(
  req,
  res,
  next
) {
  /*
   * Si API_SECRET no está configurada,
   * permitimos temporalmente.
   *
   * En producción recomiendo hacerla obligatoria.
   */
  if (!CONFIG.API_SECRET) {
    console.warn(
      "⚠️ API_SECRET no configurada."
    );

    return next();
  }

  const apiKey =
    req.headers["x-api-key"];

  if (
    typeof apiKey !== "string" ||
    apiKey !== CONFIG.API_SECRET
  ) {
    return res.status(401).json({
      success: false,
      error: "No autorizado",
    });
  }

  next();
}

/* =========================================================
   RATE LIMITER SIMPLE
========================================================= */

/*
 * Este limiter es solamente protección básica.
 *
 * En Vercel Serverless cada instancia puede tener
 * memoria diferente, así que para producción seria
 * recomiendo Redis / Upstash.
 */

const rateLimitStore = new Map();

const RATE_LIMIT = {
  WINDOW_MS: 60_000,

  MAX_REQUESTS: 20,
};

function donationRateLimiter(
  req,
  res,
  next
) {
  const ip =
    req.ip ||
    req.headers[
      "x-forwarded-for"
    ] ||
    "unknown";

  const now = Date.now();

  const current =
    rateLimitStore.get(ip);

  if (
    !current ||
    now > current.resetAt
  ) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt:
        now +
        RATE_LIMIT.WINDOW_MS,
    });

    return next();
  }

  current.count += 1;

  if (
    current.count >
    RATE_LIMIT.MAX_REQUESTS
  ) {
    return res.status(429).json({
      success: false,

      error:
        "Demasiadas solicitudes. Intenta nuevamente más tarde.",
    });
  }

  next();
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,

    service:
      "DonationWallet Backend",

    status: "running",
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",

  asyncHandler(
    async (req, res) => {
      try {
        await ensureInitialized();

        const [
          network,
          blockNumber,
          backendBalance,
        ] =
          await Promise.all([
            provider.getNetwork(),

            provider.getBlockNumber(),

            provider.getBalance(
              rawWallet.address
            ),
          ]);

        return res.json({
          success: true,

          status: "healthy",

          blockchain: {
            chainId:
              network.chainId.toString(),

            blockNumber,

            contract:
              CONFIG.CONTRACT_ADDRESS,

            backendWallet:
              rawWallet.address,

            backendEthBalance:
              ethers.formatEther(
                backendBalance
              ),
          },
        });
      } catch (error) {
        return res
          .status(503)
          .json({
            success: false,

            status:
              "unhealthy",

            error:
              sanitizeError(
                error
              ),
          });
      }
    }
  )
);

/* =========================================================
   INFO
========================================================= */

app.get(
  "/api/info",

  blockchainMiddleware,

  asyncHandler(
    async (req, res) => {
      const [
        usdcAddress,
        owner,
        contractBalance,
        network,
        blockNumber,
      ] =
        await Promise.all([
          readContract.usdcToken(),

          readContract.owner(),

          readContract.getContractBalance(),

          provider.getNetwork(),

          provider.getBlockNumber(),
        ]);

      return res.json({
        success: true,

        network: {
          name: "Ethereum Mainnet",

          chainId:
            network.chainId.toString(),

          blockNumber,
        },

        contract: {
          address:
            CONFIG.CONTRACT_ADDRESS,

          owner,

          usdcAddress,

          balanceRaw:
            contractBalance.toString(),

          balanceUsdc:
            ethers.formatUnits(
              contractBalance,
              6
            ),
        },

        backend: {
          wallet:
            rawWallet.address,

          isOwner:
            owner.toLowerCase() ===
            rawWallet.address.toLowerCase(),
        },
      });
    }
  )
);

/* =========================================================
   BALANCE
========================================================= */

app.get(
  "/api/balance/:address",

  blockchainMiddleware,

  asyncHandler(
    async (req, res) => {
      const address =
        req.params.address;

      if (
        !ethers.isAddress(address)
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Dirección Ethereum inválida",
        });
      }

      const normalizedAddress =
        ethers.getAddress(
          address
        );

      const balance =
        await usdcContract.balanceOf(
          normalizedAddress
        );

      let donationAmount = null;

      let donationError = null;

      try {
        donationAmount =
          await readContract.calculateRequiredDonation(
            normalizedAddress
          );
      } catch (error) {
        donationError =
          sanitizeError(
            error
          ).message;
      }

      return res.json({
        success: true,

        address:
          normalizedAddress,

        usdc: {
          balanceRaw:
            balance.toString(),

          balance:
            ethers.formatUnits(
              balance,
              6
            ),
        },

        donation:
          donationAmount === null
            ? {
                available:
                  false,

                error:
                  donationError,
              }
            : {
                available:
                  true,

                amountRaw:
                  donationAmount.toString(),

                amount:
                  ethers.formatUnits(
                    donationAmount,
                    6
                  ),
              },
      });
    }
  )
);

/* =========================================================
   DONOR STATS
========================================================= */

app.get(
  "/api/donor/:address",

  blockchainMiddleware,

  asyncHandler(
    async (req, res) => {
      const address =
        req.params.address;

      if (
        !ethers.isAddress(address)
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Dirección Ethereum inválida",
        });
      }

      const normalizedAddress =
        ethers.getAddress(
          address
        );

      const [total, count] =
        await readContract.getDonorStats(
          normalizedAddress
        );

      return res.json({
        success: true,

        address:
          normalizedAddress,

        totalDonatedRaw:
          total.toString(),

        totalDonated:
          ethers.formatUnits(
            total,
            6
          ),

        donationCount:
          count.toString(),
      });
    }
  )
);

/* =========================================================
   DONATE
========================================================= */

app.post(
  "/api/donate",

  donationRateLimiter,

  requireApiSecret,

  blockchainMiddleware,

  asyncHandler(
    async (req, res) => {
      const {
        donor,
        amount,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      } = req.body ?? {};

      /* -----------------------------
         VALIDACIÓN ADDRESS
      ----------------------------- */

      if (
        !donor ||
        !ethers.isAddress(donor)
      ) {
        return res.status(400).json({
          success: false,

          error:
            "donor inválido",
        });
      }

      const normalizedDonor =
        ethers.getAddress(donor);

      /* -----------------------------
         VALIDACIÓN UINT
      ----------------------------- */

      let parsedAmount;

      let parsedValidAfter;

      let parsedValidBefore;

      try {
        parsedAmount = parseUint(
          amount,
          "amount"
        );

        parsedValidAfter = parseUint(
          validAfter,
          "validAfter"
        );

        parsedValidBefore = parseUint(
          validBefore,
          "validBefore"
        );
      } catch (error) {
        return res.status(400).json({
          success: false,

          error: error.message,
        });
      }

      if (parsedAmount === 0n) {
        return res.status(400).json({
          success: false,

          error:
            "amount debe ser mayor que 0",
        });
      }

      if (
        parsedValidBefore <=
        parsedValidAfter
      ) {
        return res.status(400).json({
          success: false,

          error:
            "validBefore debe ser mayor que validAfter",
        });
      }

      /* -----------------------------
         VALIDAR VENTANA TEMPORAL
      ----------------------------- */

      const currentTimestamp =
        BigInt(
          Math.floor(
            Date.now() / 1000
          )
        );

      if (
        currentTimestamp <
        parsedValidAfter
      ) {
        return res.status(400).json({
          success: false,

          error:
            "La autorización todavía no es válida",
        });
      }

      if (
        currentTimestamp >
        parsedValidBefore
      ) {
        return res.status(400).json({
          success: false,

          error:
            "La autorización ha expirado",
        });
      }

      /* -----------------------------
         VALIDAR NONCE
      ----------------------------- */

      if (!isBytes32(nonce)) {
        return res.status(400).json({
          success: false,

          error:
            "nonce debe ser bytes32",
        });
      }

      /* -----------------------------
         VALIDAR FIRMA
      ----------------------------- */

      if (!isBytes32(r)) {
        return res.status(400).json({
          success: false,

          error:
            "r debe ser bytes32",
        });
      }

      if (!isBytes32(s)) {
        return res.status(400).json({
          success: false,

          error:
            "s debe ser bytes32",
        });
      }

      const parsedV = Number(v);

      if (
        !Number.isInteger(parsedV) ||
        ![0, 1, 27, 28].includes(
          parsedV
        )
      ) {
        return res.status(400).json({
          success: false,

          error:
            "v inválido",
        });
      }

      console.log(
        `📥 Nueva donación: donor=${normalizedDonor} amount=${parsedAmount}`
      );

      /* =====================================================
         COMPROBAR ETH PARA GAS
      ===================================================== */

      const backendEthBalance =
        await provider.getBalance(
          rawWallet.address
        );

      if (backendEthBalance === 0n) {
        return res.status(503).json({
          success: false,

          error:
            "Backend sin ETH para pagar gas",
        });
      }

      /* =====================================================
         SIMULAR PRIMERO
      ===================================================== */

      try {
        await contract.processDonation.staticCall(
          normalizedDonor,
          parsedAmount,
          parsedValidAfter,
          parsedValidBefore,
          nonce,
          parsedV,
          r,
          s
        );
      } catch (error) {
        const safeError =
          sanitizeError(error);

        console.warn(
          "⚠️ Simulación rechazada:",
          safeError
        );

        return res.status(400).json({
          success: false,

          error:
            "La donación sería rechazada por el contrato",

          reason:
            safeError.message,
        });
      }

      /* =====================================================
         ESTIMAR GAS
      ===================================================== */

      let estimatedGas;

      try {
        estimatedGas =
          await contract.processDonation.estimateGas(
            normalizedDonor,
            parsedAmount,
            parsedValidAfter,
            parsedValidBefore,
            nonce,
            parsedV,
            r,
            s
          );
      } catch (error) {
        return res.status(400).json({
          success: false,

          error:
            "No se pudo estimar el gas",

          reason:
            sanitizeError(
              error
            ).message,
        });
      }

      /*
       * Dejamos margen del 20%.
       */
      const gasLimit =
        (estimatedGas * 120n) /
        100n;

      console.log(
        "⛽ Gas estimado:",
        estimatedGas.toString()
      );

      /* =====================================================
         ENVIAR
      ===================================================== */

      const tx =
        await contract.processDonation(
          normalizedDonor,
          parsedAmount,
          parsedValidAfter,
          parsedValidBefore,
          nonce,
          parsedV,
          r,
          s,
          {
            gasLimit,
          }
        );

      console.log(
        "📤 Tx enviada:",
        tx.hash
      );

      /* =====================================================
         ESPERAR RECEIPT
      ===================================================== */

      const receipt =
        await tx.wait(
          CONFIG.CONFIRMATIONS
        );

      if (!receipt) {
        throw new Error(
          "No se obtuvo receipt de la transacción"
        );
      }

      /*
       * status:
       * 1 = éxito
       * 0 = revert
       */
      if (receipt.status !== 1) {
        throw new Error(
          "La transacción fue revertida"
        );
      }

      /* =====================================================
         EVENTOS
      ===================================================== */

      let donationReceivedEvent =
        null;

      let donationFailedEvent =
        null;

      for (
        const log of receipt.logs
      ) {
        try {
          const parsed =
            readContract.interface.parseLog(
              log
            );

          if (
            parsed?.name ===
            "DonationReceived"
          ) {
            donationReceivedEvent =
              parsed;
          }

          if (
            parsed?.name ===
            "DonationFailed"
          ) {
            donationFailedEvent =
              parsed;
          }
        } catch {
          // log perteneciente a otro contrato
        }
      }

      if (donationFailedEvent) {
        return res.status(400).json({
          success: false,

          transactionMined: true,

          txHash: tx.hash,

          blockNumber:
            receipt.blockNumber,

          error:
            donationFailedEvent
              .args?.reason ??
            "DonationFailed",

          explorerUrl:
            `https://etherscan.io/tx/${tx.hash}`,
        });
      }

      if (!donationReceivedEvent) {
        console.warn(
          `⚠️ Tx ${tx.hash} minada pero no se encontró DonationReceived`
        );
      }

      /* =====================================================
         RESPUESTA
      ===================================================== */

      return res.json({
        success: true,

        txHash: tx.hash,

        blockNumber:
          receipt.blockNumber,

        confirmations:
          CONFIG.CONFIRMATIONS,

        gasUsed:
          receipt.gasUsed.toString(),

        donor:
          normalizedDonor,

        amountRaw:
          parsedAmount.toString(),

        amountUsdc:
          ethers.formatUnits(
            parsedAmount,
            6
          ),

        donationReceived:
          Boolean(
            donationReceivedEvent
          ),

        explorerUrl:
          `https://etherscan.io/tx/${tx.hash}`,
      });
    }
  )
);

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  return res.status(404).json({
    success: false,

    error:
      "Ruta no encontrada",
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    const safeError =
      sanitizeError(err);

    console.error(
      "❌ Error global:",
      safeError
    );

    if (
      err?.message ===
      "Origen no permitido por CORS"
    ) {
      return res
        .status(403)
        .json({
          success: false,

          error:
            "Origen no permitido",
        });
    }

    return res
      .status(500)
      .json({
        success: false,

        error:
          "Error interno del servidor",

        /*
         * En producción puedes eliminar details
         * si quieres ocultar aún más información.
         */
        details:
          safeError.message,

        code:
          safeError.code,
      });
  }
);

/* =========================================================
   EXPORT VERCEL
========================================================= */

export default app;
