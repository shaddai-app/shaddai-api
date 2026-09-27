/**
 * Textos del servidor para planillas (importar/exportar). Los catálogos del sistema se muestran
 * traducidos en el front; acá se repiten solo los que aparecen en archivos.
 */
export type Locale = 'es' | 'en' | 'pt';

export const STATUS_LABELS: Record<string, Record<Locale, string>> = {
  visitor: { es: 'Visitante', en: 'Visitor', pt: 'Visitante' },
  new: { es: 'Nuevo', en: 'New', pt: 'Novo' },
  attendee: { es: 'Asistente', en: 'Attendee', pt: 'Frequentador' },
  member: { es: 'Miembro', en: 'Member', pt: 'Membro' },
  inactive: { es: 'Inactivo', en: 'Inactive', pt: 'Inativo' },
  transferred: { es: 'Trasladado', en: 'Transferred', pt: 'Transferido' },
  deceased: { es: 'Fallecido', en: 'Deceased', pt: 'Falecido' },
};

export const GENDER_LABELS: Record<'F' | 'M', Record<Locale, string>> = {
  F: { es: 'Femenino', en: 'Female', pt: 'Feminino' },
  M: { es: 'Masculino', en: 'Male', pt: 'Masculino' },
};

export const MARITAL_LABELS: Record<string, Record<Locale, string>> = {
  single: { es: 'Soltero/a', en: 'Single', pt: 'Solteiro/a' },
  married: { es: 'Casado/a', en: 'Married', pt: 'Casado/a' },
  widowed: { es: 'Viudo/a', en: 'Widowed', pt: 'Viúvo/a' },
  divorced: { es: 'Divorciado/a', en: 'Divorced', pt: 'Divorciado/a' },
  separated: { es: 'Separado/a', en: 'Separated', pt: 'Separado/a' },
};

/** Sinónimos aceptados al importar (ya "plegados": minúsculas, sin acentos). */
export const GENDER_ALIASES: Record<string, 'F' | 'M'> = {
  f: 'F',
  femenino: 'F',
  mujer: 'F',
  female: 'F',
  woman: 'F',
  feminino: 'F',
  m: 'M',
  masculino: 'M',
  hombre: 'M',
  varon: 'M',
  male: 'M',
  man: 'M',
  h: 'M',
};

export const MARITAL_ALIASES: Record<string, string> = {
  soltero: 'single',
  soltera: 'single',
  'soltero/a': 'single',
  single: 'single',
  solteiro: 'single',
  solteira: 'single',
  casado: 'married',
  casada: 'married',
  'casado/a': 'married',
  married: 'married',
  viudo: 'widowed',
  viuda: 'widowed',
  'viudo/a': 'widowed',
  widowed: 'widowed',
  viuvo: 'widowed',
  viuva: 'widowed',
  divorciado: 'divorced',
  divorciada: 'divorced',
  'divorciado/a': 'divorced',
  divorced: 'divorced',
  separado: 'separated',
  separada: 'separated',
  'separado/a': 'separated',
  separated: 'separated',
};

export type PersonColumn =
  | 'firstName'
  | 'lastName'
  | 'preferredName'
  | 'gender'
  | 'birthDate'
  | 'email'
  | 'phone'
  | 'documentNumber'
  | 'maritalStatus'
  | 'address'
  | 'city'
  | 'province'
  | 'status'
  | 'campus'
  | 'tags'
  | 'firstVisitAt'
  | 'notes';

export interface ColumnDef {
  key: PersonColumn;
  header: Record<Locale, string>;
  /** Otros encabezados aceptados al importar (se comparan plegados). */
  aliases: string[];
  required?: boolean;
  sensitive?: boolean;
}

export const PERSON_COLUMNS: ColumnDef[] = [
  {
    key: 'firstName',
    header: { es: 'Nombre', en: 'First name', pt: 'Nome' },
    aliases: ['nombres', 'firstname', 'first_name', 'primer nombre', 'primeiro nome'],
    required: true,
  },
  {
    key: 'lastName',
    header: { es: 'Apellido', en: 'Last name', pt: 'Sobrenome' },
    aliases: ['apellidos', 'lastname', 'last_name', 'surname'],
    required: true,
  },
  {
    key: 'preferredName',
    header: { es: 'Apodo', en: 'Preferred name', pt: 'Apelido' },
    aliases: ['como le dicen', 'nickname', 'sobrenombre'],
  },
  { key: 'gender', header: { es: 'Género', en: 'Gender', pt: 'Gênero' }, aliases: ['sexo', 'sex', 'genero'] },
  {
    key: 'birthDate',
    header: { es: 'Fecha de nacimiento', en: 'Birth date', pt: 'Data de nascimento' },
    aliases: ['nacimiento', 'fecha nacimiento', 'birthdate', 'date of birth', 'dob', 'nascimento'],
  },
  { key: 'email', header: { es: 'Email', en: 'Email', pt: 'E-mail' }, aliases: ['correo', 'mail', 'e-mail'] },
  {
    key: 'phone',
    header: { es: 'Teléfono', en: 'Phone', pt: 'Telefone' },
    aliases: ['celular', 'movil', 'whatsapp', 'mobile', 'tel'],
  },
  {
    key: 'documentNumber',
    header: { es: 'Documento', en: 'ID number', pt: 'Documento' },
    aliases: ['dni', 'document', 'cpf', 'rg', 'nro documento'],
    sensitive: true,
  },
  {
    key: 'maritalStatus',
    header: { es: 'Estado civil', en: 'Marital status', pt: 'Estado civil' },
    aliases: [],
    sensitive: true,
  },
  {
    key: 'address',
    header: { es: 'Dirección', en: 'Address', pt: 'Endereço' },
    aliases: ['domicilio', 'direccion', 'endereco', 'calle'],
    sensitive: true,
  },
  { key: 'city', header: { es: 'Ciudad', en: 'City', pt: 'Cidade' }, aliases: ['localidad', 'municipio'] },
  {
    key: 'province',
    header: { es: 'Provincia', en: 'State', pt: 'Estado (UF)' },
    aliases: ['province', 'uf'],
  },
  // "Estado" en castellano es el estado de la persona (visitante, miembro…), no la provincia.
  {
    key: 'status',
    header: { es: 'Estado', en: 'Status', pt: 'Situação' },
    aliases: ['situacion', 'situacao'],
  },
  { key: 'campus', header: { es: 'Sede', en: 'Campus', pt: 'Sede' }, aliases: ['filial'] },
  { key: 'tags', header: { es: 'Etiquetas', en: 'Tags', pt: 'Etiquetas' }, aliases: ['grupos', 'tag'] },
  {
    key: 'firstVisitAt',
    header: { es: 'Primera visita', en: 'First visit', pt: 'Primeira visita' },
    aliases: ['fecha primera visita', 'primer visita', 'first visit date'],
  },
  {
    key: 'notes',
    header: { es: 'Notas', en: 'Notes', pt: 'Observações' },
    aliases: ['observaciones', 'comentarios', 'notas', 'observacoes'],
  },
];
