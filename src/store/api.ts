import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { HydrationBlob } from "./courtSlice";

const KEY = "pair-wise-yf-49/court";

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getCourtState: builder.query<HydrationBlob, void>({
      queryFn: async () => {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { data: {} };
        const parsed = JSON.parse(raw) as HydrationBlob & { evidence?: unknown };
        // 旧格式只有 evidence：缺设备和基线，交给 slice 升级补来源
        return { data: { evidence: parsed.evidence as never, objections: parsed.objections, sync: parsed.sync } };
      }
    }),
    saveCourtState: builder.mutation<{ ok: true }, HydrationBlob>({
      queryFn: async (payload) => {
        localStorage.setItem(KEY, JSON.stringify(payload));
        return { data: { ok: true } };
      }
    })
  })
});
export const { useGetCourtStateQuery, useSaveCourtStateMutation } = courtApi;
