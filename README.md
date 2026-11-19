# Luca Pellegrini

Apri `index.html` per provare il sito in locale. Per pubblicarlo, copia il contenuto della cartella nella radice del repository `<username>.github.io` e imposta GitHub Pages per servire quella cartella dal branch scelto. Tutte le risorse sono incluse.

## Personalizzazione

Modifica `config.js` e ricarica la pagina.

| Campo | Valore da inserire |
| --- | --- |
| `PROFILE.affiliation` | Affiliazione da mostrare sotto il nome |
| `PROFILE.email` | Indirizzo email, senza il prefisso `mailto:` |
| `PROFILE.github` | URL completo del profilo GitHub |
| `PROFILE.linkedin` | URL completo del profilo LinkedIn |
| `FLOW_MODE` | `"inflow"` per la corrente da sinistra, `"still"` per partire in quiete |

## Interazione

Muovi il puntatore sul riquadro oppure trascina con un dito. Da tastiera, seleziona la simulazione con Tab e usa le frecce. Il pulsante sole/luna salva il tema nel browser. La preferenza di movimento ridotto disattiva le animazioni decorative.

## Simulazione

`fluid.js` evolve le velocità su una griglia sfalsata MAC. Combina advezione semi-lagrangiana con correzione MacCormack limitata, diffusione viscosa esplicita e proiezione della pressione con rilassamento iterativo. Le facce della griglia a contatto con il cilindro assumono la velocità del solido. I marcatori vengono trasportati con un integratore al punto medio.

In modalità `inflow`, `wake.js` fornisce due stati iniziali precalcolati con lo stesso solutore, per formati larghi e stretti. Il browser interpola lo stato sulla griglia del riquadro e continua il calcolo a ogni passo. In modalità `still`, tutte le velocità iniziali sono nulle e il cilindro mette in moto il fluido.
