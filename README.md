# Luca Pellegrini

Apri `index.html` per provare il sito. Per pubblicarlo, copia i file nella radice del repository `<username>.github.io` e seleziona quella cartella come sorgente di GitHub Pages. Tutte le risorse sono incluse.

## Personalizzazione

In `config.js`, modifica i campi `PROFILE.affiliation`, `PROFILE.email`, `PROFILE.github` e `PROFILE.linkedin`. Inserisci l’indirizzo email senza prefisso e gli URL completi dei profili.

Imposta `FLOW_MODE` su `"still"` per la quiete iniziale (predefinita) o su `"inflow"` per la corrente da sinistra. Ricarica la pagina dopo una modifica.

## Interazione

Con il mouse, il disco è il cursore di sistema con il centro sul punto di interazione. Il cilindro fisico nasce all’ingresso e viene rimosso all’uscita. Su touch appare sotto il dito e scompare al rilascio. Da tastiera, seleziona il riquadro con Tab e usa le frecce.

## Superficie

`fluid.js` integra il campo di velocità su una griglia MAC con advezione, diffusione viscosa e proiezione della pressione. `surface.js` calcola un campo di altezza smorzato, trasportato dalla velocità del fluido. Il passaggio del cilindro deforma la superficie. L’effetto mercurio deriva dalla luce riflessa sulle sue pendenze e dalla curvatura ai bordi della vaschetta. La modalità in quiete sospende il calcolo quando le perturbazioni si sono dissipate.
