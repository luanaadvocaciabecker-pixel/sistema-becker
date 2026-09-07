-- Cadastro dos 30 processos extrajudiciais/administrativos em `processos_adm`.
-- Aplicado em 2026-09-06.
--
-- Origem: as 39 linhas da aba ATIVOS ATUAL da planilha "PRAZOS BECKER 2026" que não têm
-- CNJ. A Luana identificou o grupo: "os inss da Alana e os detran que são os extras".
-- Classificação pela coluna TRIBUNAL da planilha:
--   GERID / Meu INSS ... 12   (previdenciário)
--   DETRAN DIGITAL ......7  + DETRAN 1   (suspensão/infração, multa)
--   EXTRAJUDICIAL .......7   (parecer, inventário, averbação, divórcio, doação, falência)
--   ASSESSORIA ..........2
--   ADMINISTRATIVO ......1
--                       ----
--                        30
--
-- Ficaram DE FORA (não são extrajudiciais):
--   4 do STJ (AREsp) — recursos, aguardando decisão da Luana sobre como registrar;
--   1 do TRT12 (ANDRÉ FREITAS, da Samaira) — CNJ destruído por fórmula do Excel
--     ("0001415-04.202+A530:N5336.5.12"), não existe no sistema, precisa do número real;
--   2 sem número mas com classe judicial (Execução de Título Extrajudicial, Monitória);
--   2 previdenciários que repetem protocolos GERID já incluídos.
--
-- DUAS REGRAS APLICADAS NA CARGA:
--   1. A coluna de protocolo do DETRAN na planilha traz login E SENHA no mesmo campo.
--      A senha NÃO é gravada no banco — só fica a nota em `observacoes`. O acesso
--      continua exclusivamente na planilha.
--   2. Cliente só é vinculado com correspondência EXATA de nome. Onde não houve, o
--      registro entra com cliente_id nulo e o nome da parte anotado em `observacoes`,
--      para vinculação manual. Nenhum vínculo foi adivinhado.
--      Resultado: 19 dos 30 com cliente; 11 pendentes.
--      Pendentes prováveis mas não idênticos (precisam do ok dela):
--        HEITOR HASHIMOTO  -> existe HEITOR MARCOS HASHIMOTO (duplicado: ids 614 e 1414)
--        JOSIANE PEREIRA   -> existe JOSIANE PEREIRA SCHMOELLER
--      Pendentes sem cadastro de cliente: ABEL ALFREN, ANDERSON L MONFERNATTI,
--        HALLEX DAVIDSON MANDIRA NEVES, JONI COLLINS, JONNIS,
--        KARIN BEATRIZ SCHULZ PIANTÁ, FAMÍLIA DRESCH, FAMÍLIA TREVIZAN.

insert into processos_adm(cliente_id,orgao,numero_protocolo,assunto,responsavel,situacao,observacoes) values
(1302,'DETRAN','33743/2026','MULTA DE TRANSITO','Alana Pais Lemos','Em análise',null),
(263,'GERID / Meu INSS','1639901898',null,'Alana Pais Lemos','Em análise',null),
(589,'GERID / Meu INSS','1226061855',null,'Alana Pais Lemos','Em análise',null),
(null,'GERID / Meu INSS','1134241452',null,'Alana Pais Lemos','Em análise','Parte na planilha: HALLEX DAVIDSON MANDIRA NEVES — cliente ainda não vinculado'),
(656,'GERID / Meu INSS','815868853',null,'Alana Pais Lemos','Em análise',null),
(766,'GERID / Meu INSS','257179925',null,'Luana Fernandes','Em análise',null),
(917,'GERID / Meu INSS','961072813',null,'Alana Pais Lemos','Em análise',null),
(1105,'GERID / Meu INSS','1718160233',null,'Alana Pais Lemos','Em análise',null),
(1105,'GERID / Meu INSS','975029152',null,'Alana Pais Lemos','Em análise',null),
(1145,'GERID / Meu INSS','115113617',null,'Alana Pais Lemos','Em análise',null),
(1193,'GERID / Meu INSS','1230551740',null,'Alana Pais Lemos','Em análise',null),
(199,'GERID / Meu INSS','1738949459',null,'Alana Pais Lemos','Em análise',null),
(201,'GERID / Meu INSS','419414468',null,'Alana Pais Lemos','Em análise',null),
(874,'EXTRAJUDICIAL',null,'CREDOR EM FALENCIA','Alana Pais Lemos','Em análise','número ilegível na planilha (corrompido pelo Excel) — conferir o CNJ real'),
(1166,'DETRAN DIGITAL','LOGIN: 2021.102942.PSH02035649807','SUSPENSÃO/INFRAÇÃO','Alana Pais Lemos','Em análise','senha do acesso fica só na planilha, não é gravada aqui'),
(null,'DETRAN DIGITAL','LOGIN: 2023.195810.PSH02058937579','SUSPENSÃO/INFRAÇÃO','Alana Pais Lemos','Em análise','Parte na planilha: HEITOR HASHIMOTO — cliente ainda não vinculado; senha do acesso fica só na planilha, não é gravada aqui'),
(1095,'DETRAN DIGITAL','LOGIN: 2022.69281.PSH02213955683','SUSPENSÃO/INFRAÇÃO','Alana Pais Lemos','Em análise','senha do acesso fica só na planilha, não é gravada aqui'),
(null,'DETRAN DIGITAL','LOGIN: 2023.205657.PSH01972482796','SUSPENSÃO/INFRAÇÃO','Alana Pais Lemos','Em análise','Parte na planilha: ANDERSON L MONFERNATTI — cliente ainda não vinculado; senha do acesso fica só na planilha, não é gravada aqui'),
(833,'DETRAN DIGITAL','PROTOCOLO: 8806.7579.P0A7E000JK','SUSPENSÃO/INFRAÇÃO','Maria Helena','Em análise','senha do acesso fica só na planilha, não é gravada aqui'),
(962,'DETRAN DIGITAL','PROTOCOLO: 8806.7579.P07XB0030','SUSPENSÃO/INFRAÇÃO','Alana Pais Lemos','Em análise','senha do acesso fica só na planilha, não é gravada aqui'),
(null,'DETRAN DIGITAL','PROTOCOLO: 2023.254644.PSH00973280202','SUSPENSÃO/INFRAÇÃO','Alana Pais Lemos','Em análise','Parte na planilha: ABEL ALFREN — cliente ainda não vinculado; senha do acesso fica só na planilha, não é gravada aqui'),
(1512,'ADMINISTRATIVO',null,'NOVOS NEGOCIOS / CONSULTIVO / SEM Nº DE PROCESSO','Alana Pais Lemos','Em análise',null),
(null,'EXTRAJUDICIAL',null,'ASSESSORIA / CONSULTIVO / SEM Nº DE PROCESSO','Alana Pais Lemos','Em análise','Parte na planilha: JONNIS — cliente ainda não vinculado'),
(null,'ASSESSORIA',null,'ADM / CONSULTIVO / SEM Nº DE PROCESSO','Alana Pais Lemos','Em análise','Parte na planilha: JONNIS — cliente ainda não vinculado'),
(null,'EXTRAJUDICIAL',null,'PARECER / CONSULTIVO / SEM Nº DE PROCESSO','Alana Pais Lemos','Em análise','Parte na planilha: KARIN BEATRIZ SCHULZ PIANTÁ — cliente ainda não vinculado'),
(1169,'EXTRAJUDICIAL',null,'INVENTÁRIO / CONSULTIVO / SEM Nº DE PROCESSO','Maria Helena','Em análise',null),
(null,'EXTRAJUDICIAL',null,'AVERBAÇÃO / CONSULTIVO / SEM Nº DE PROCESSO','Alana Pais Lemos','Em análise','Parte na planilha: FAMÍLIA TREVIZAN — cliente ainda não vinculado'),
(null,'EXTRAJUDICIAL',null,'DIVÓRCIO / CONSULTIVO / SEM Nº DE PROCESSO','Maria Helena','Em análise','Parte na planilha: JOSIANE PEREIRA — cliente ainda não vinculado'),
(null,'ASSESSORIA',null,'ADMINISTRATIVO / CONSULTIVO / SEM Nº DE PROCESSO','Alana Pais Lemos','Em análise','Parte na planilha: JONI COLLINS — cliente ainda não vinculado'),
(null,'EXTRAJUDICIAL',null,'DOAÇÃO / CONSULTIVO / SEM Nº DE PROCESSO','Maria Helena','Em análise','Parte na planilha: FAMÍLIA DRESCH — cliente ainda não vinculado');

-- ---------------------------------------------------------------------------
-- DESFAZER
-- ---------------------------------------------------------------------------
--   delete from processos_adm;
--
-- Vincular um pendente depois que o cliente existir:
--   update processos_adm set cliente_id = <id>, observacoes = null
--   where id = <id_do_administrativo>;
