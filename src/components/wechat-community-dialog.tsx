"use client";

import Image from "next/image";
import { useState } from "react";

import { track } from "@vercel/analytics";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { WeChatIcon } from "@/components/icons/wechat-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Use the same server-side proxy as the collaborator QR panel. The raw
// Aliyun object may be private, and Next's optimizer can keep serving an
// expired QR after rotation.
const WECHAT_QR_URL = "/api/wechat-qr";

function WechatQrImage({ className }: { className?: string }) {
  const [imageLoaded, setImageLoaded] = useState(false);

  return (
    <div
      className={cn(
        "relative rounded-2xl border border-border-base bg-white p-3",
        className,
      )}
    >
      {imageLoaded ? null : (
        <div className="absolute inset-3 grid place-items-center rounded-xl bg-surface-muted text-muted-2">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            二维码加载中…
          </div>
        </div>
      )}
      <Image
        src={WECHAT_QR_URL}
        alt="Petdex 微信群二维码"
        width={320}
        height={320}
        unoptimized
        className={`mx-auto aspect-square w-full max-w-72 rounded-xl object-contain transition-opacity duration-200 ${
          imageLoaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setImageLoaded(true)}
      />
    </div>
  );
}

type WechatCommunityDialogProps = {
  className?: string;
  source?: string;
  children?: React.ReactNode;
};

export function WechatCommunityDialog({
  className,
  source = "community_page_hero",
  children = "加入微信群",
}: WechatCommunityDialogProps) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) track("wechat_qr_open", { source });
      }}
    >
      <DialogTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-11 items-center gap-2 rounded-full border border-[#07C160]/25 bg-[#07C160]/12 px-5 text-sm font-semibold text-[#07C160] backdrop-blur transition hover:bg-[#07C160]/18",
              className,
            )}
            onClick={() => {
              track("wechat_click", { source });
            }}
          >
            <WeChatIcon className="size-4" />
            {children}
          </button>
        }
      />
      <DialogContent className="gap-5 p-5 sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            加入 Petdex 微信群
          </DialogTitle>
          <DialogDescription className="text-sm leading-6">
            微信扫码加入中文社区，交流 Codex pet 创作、提交和反馈。
          </DialogDescription>
        </DialogHeader>

        <WechatQrImage />

        <p className="text-xs leading-5 text-muted-2">
          二维码可能会过期。如果无法加入，请通过 GitHub 或 Discord 联系维护者。
        </p>
      </DialogContent>
    </Dialog>
  );
}

export function WechatCommunityQrCard() {
  return (
    <div className="mt-8 max-w-sm rounded-3xl border border-[#07C160]/20 bg-[#07C160]/8 p-4 shadow-sm backdrop-blur">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#07C160]">
        <WeChatIcon className="size-4" />
        加入 Petdex 微信群
      </div>
      <WechatQrImage className="border-[#07C160]/20" />
      <p className="mt-3 text-xs leading-5 text-muted-2">
        微信扫码加入中文社区。二维码过期时，Henry 可以在协作者页面更新。
      </p>
    </div>
  );
}
