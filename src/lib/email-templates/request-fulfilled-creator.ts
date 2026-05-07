import {
  normalizeLocale,
  p,
  petdexUrl,
  wrapEmail,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type Vars = {
  petName: string;
  petSlug: string;
  requestQuery: string;
};

export function renderRequestFulfilledCreatorEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const petUrl = petdexUrl(current, `/pets/${vars.petSlug}`);

  const copy =
    current === "es"
      ? {
          subject: `${vars.petName} cumplió un pedido de la comunidad`,
          intro: `Tu mascota ${vars.petName} cumplió el pedido "${vars.requestQuery}" de la comunidad.`,
          body: "Otros usuarios podrán encontrarla más fácil ahora. Gracias por aportar al catálogo.",
          cta: `Ver: ${petUrl}`,
        }
      : current === "zh"
        ? {
            subject: `${vars.petName} 完成了社区请求`, // fixme:zh
            intro: `你的宠物 ${vars.petName} 满足了社区请求 "${vars.requestQuery}"。`, // fixme:zh
            body: "现在其他用户更容易找到它。感谢你的贡献。", // fixme:zh
            cta: `查看：${petUrl}`, // fixme:zh
          }
        : {
            subject: `${vars.petName} fulfilled a community request`,
            intro: `Your pet ${vars.petName} fulfilled the community request "${vars.requestQuery}".`,
            body: "It will now be easier for others to find. Thanks for contributing to the catalog.",
            cta: `View: ${petUrl}`,
          };

  const text = [copy.intro, "", copy.body, "", copy.cta, "", "Petdex"].join(
    "\n",
  );
  const html = wrapEmail(copy.subject, [
    p(copy.intro),
    p(copy.body),
    p(copy.cta),
  ]);

  return { subject: copy.subject, html, text };
}
