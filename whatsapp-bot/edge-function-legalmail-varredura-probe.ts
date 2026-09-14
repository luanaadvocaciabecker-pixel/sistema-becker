// Sondagem TEMPORARIA neutralizada em 14/09/2026 -- serviu para (1) confirmar datas de
// disponibilizacao via case-files para os prints "Meus Expedientes", e (2) rodar sync_ids +
// case-files para os 6 processos recem-cadastrados sem cliente. Resultado documentado em
// db/trt_gera_prazos.sql. Mantida so como registro; nao processa nada.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({neutralizada:true, motivo:"sondagem pontual concluida em 14/09/2026"}), {status:410, headers:{"Content-Type":"application/json"}}));
