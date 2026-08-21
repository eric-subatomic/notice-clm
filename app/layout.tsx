import type { Metadata } from "next";
import { headers } from "next/headers";
import { getPermissionContext, NoticeAuthError } from "./lib/auth";
import { getNoticeConfig, NoticeConfigurationError } from "./lib/config";
import "./globals.css";

export const dynamic = "force-dynamic";

function loopbackOrigin(host: string | null): string | null {
  if (!host) return null;
  try {
    const candidate = new URL(`http://${host}`);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(candidate.hostname)
      ? candidate.origin
      : null;
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const localOrigin = loopbackOrigin(requestHeaders.get("host"));
  let baseUrl = localOrigin ?? "https://notice.invalid";
  try {
    baseUrl = getNoticeConfig().publicBaseUrl ?? baseUrl;
  } catch {
    // Incomplete production configuration intentionally renders the setup
    // gate below; metadata must not revive an untrusted Host value.
  }

  return {
    metadataBase: new URL(baseUrl),
    title: "Notice — Agreement Operations",
    description: "Create, negotiate, approve, sign, and manage every business agreement in one calm workspace.",
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
    },
    openGraph: {
      title: "Notice — Agreements that move",
      description: "Create. Negotiate. Approve. Sign. Manage. One workspace for every business agreement.",
      type: "website",
      images: [{ url: `${baseUrl}/og.png`, width: 1536, height: 1024, alt: "Notice agreement operations workspace" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Notice — Agreements that move",
      description: "Create. Negotiate. Approve. Sign. Manage. One workspace for every business agreement.",
      images: [`${baseUrl}/og.png`],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const requestOrigin = loopbackOrigin(requestHeaders.get("host")) ?? "https://notice.invalid";
  let accessProblem: { title: string; message: string; code: string } | null = null;
  try {
    await getPermissionContext(new Request(`${requestOrigin}/`, { headers: new Headers(requestHeaders) }));
  } catch (error) {
    if (error instanceof NoticeConfigurationError) {
      accessProblem = {
        title: "Deployment setup is incomplete",
        message: "Notice is locked until the production workspace, identity boundary, and bootstrap administrator are configured.",
        code: error.code,
      };
    } else if (error instanceof NoticeAuthError) {
      accessProblem = {
        title: "Workspace access required",
        message: error.message,
        code: error.code,
      };
    } else {
      accessProblem = {
        title: "Secure session unavailable",
        message: "Notice could not verify this workspace session. Try again or contact the deployment administrator.",
        code: "SESSION_UNAVAILABLE",
      };
    }
  }

  return (
    <html lang="en">
      <body>
        {accessProblem ? (
          <main className="access-gate">
            <section>
              <span className="clm-mark" aria-hidden="true"><i /></span>
              <p>NOTICE / SECURE WORKSPACE</p>
              <h1>{accessProblem.title}</h1>
              <p>{accessProblem.message}</p>
              <code>{accessProblem.code}</code>
            </section>
          </main>
        ) : children}
      </body>
    </html>
  );
}
